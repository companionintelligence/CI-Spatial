/**
 * The tag detector, on synthetic frames drawn at known poses (`tests/support/fiducial-render.ts`).
 *
 * What these tests can and cannot say. Every frame is rendered by a pinhole model with Gaussian
 * noise, Gaussian blur and an exposure curve; there is no lens distortion, rolling shutter, motion
 * blur, demosaicing or glare. A detection rate here is a rate on THAT world. DX8 on a phone is what
 * says how the real one differs, and nothing below stands in for it.
 *
 * The false-positive tests run noise-only frames and frames of rooms' worth of structure (furniture,
 * text, tiles, dark squares with random grids). Zero detections is the expectation, and a result
 * of zero over N frames bounds the per-frame rate below about 3 / N at 95 % confidence; it is not
 * a proof. Each such test also counts how many candidates reached the dictionary stage, so that a
 * detector which never gets that far cannot pass them by doing nothing.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_detector.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CSCAN5_V1, createDictionary } from '../../../src/ar/fiducial/dictionary.ts'
import { searchFamily } from '../../../src/ar/fiducial/dictionary-search.ts'
import {
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_MAX_HAMMING,
  FiducialDetector,
  detectFiducials,
  groupCandidates,
  imageFromCameraPixelArray,
  imageFromRawFrame,
  measureDetectorCost,
  refinementWindowPx,
  type Candidate,
} from '../../../src/ar/fiducial/detector.ts'
import {
  INTRINSICS_1280,
  INTRINSICS_640,
  dictionaryTagArtwork,
  mat3Apply,
  noiseOnlyFrame,
  randomNonCode,
  renderFrame,
  renderTag,
  tagArtwork,
  tagPose,
  textureFrame,
  type PlacedArtwork,
  type RigidPose,
  type TextureKind,
} from '../../support/fiducial-render.ts'
import type { CameraIntrinsics, FiducialImage } from '../../../src/ar/fiducial/types.ts'
import { solveTagPose } from '../../../src/ar/fiducial/tag-pose.ts'
import { mulberry32 } from '../../../src/shared/test-homes.ts'

const K = INTRINSICS_640
const SIZE_M = 0.2

/** Where the tag's printed corners really land: top-left, top-right, bottom-right, bottom-left. */
function truthCorners(pose: RigidPose, k: CameraIntrinsics, sizeM = SIZE_M) {
  const h = sizeM / 2
  return [[-h, h], [h, h], [h, -h], [-h, -h]].map(([x, y]) => {
    const p = mat3Apply(pose.rotation, { x: x!, y: y!, z: 0 })
    const X = p.x + pose.translation.x
    const Y = p.y + pose.translation.y
    const Z = p.z + pose.translation.z
    return { x: (k.fx * X) / Z + k.cx, y: (k.fy * Y) / Z + k.cy }
  })
}

function cornerErrors(found: ReadonlyArray<{ x: number; y: number }>, truth: ReadonlyArray<{ x: number; y: number }>): number[] {
  return found.map((c, i) => Math.hypot(c.x - truth[i]!.x, c.y - truth[i]!.y))
}

function percentile(values: number[], p: number): number {
  const a = values.slice().sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(p * a.length))]!
}

test('a clean tag decodes at every id and in-plane turn, corners in printed order and within a third of a pixel', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  for (let id = 0; id < CSCAN5_V1.size; id++) {
    const spin = (id % 4) * 90 + (id * 7) % 25
    const pose = tagPose({ x: ((id % 5) - 2) * 0.07, y: ((id % 3) - 1) * 0.06, z: 1.4 + (id % 4) * 0.35 }, spin, ((id * 11) % 50) - 25, ((id * 17) % 30) - 15)
    const found = det.detect(renderTag({ dictionary: CSCAN5_V1, id, sizeM: SIZE_M, pose, intrinsics: K, supersample: 5 }))
    assert.equal(found.length, 1, `id ${id}: ${found.length} detections`)
    const d = found[0]!
    assert.equal(d.id, id)
    assert.equal(d.family, 'cscan-5x5-v1')
    assert.equal(d.hamming, 0)
    assert.equal(d.refined, true)
    const errs = cornerErrors(d.corners, truthCorners(pose, K))
    assert.ok(Math.max(...errs) < 0.35, `id ${id} spin ${spin}: corner errors ${errs.map((e) => e.toFixed(2)).join(' ')} px (a rotated corner order would be tens of pixels)`)
  }
})

test('corners are sub-pixel under noise and blur, and the refinement is what makes them so', () => {
  const refined = new FiducialDetector(CSCAN5_V1)
  const coarse = new FiducialDetector(CSCAN5_V1, { refineCorners: false })
  const rand = mulberry32(31)
  const withRefine: number[] = []
  const without: number[] = []
  for (let i = 0; i < 60; i++) {
    const id = Math.floor(rand() * 32)
    const range = 1.2 + rand() * 1.6
    const pose = tagPose({ x: (rand() - 0.5) * 0.4, y: (rand() - 0.5) * 0.3, z: range }, rand() * 360, (rand() - 0.5) * 60, (rand() - 0.5) * 40)
    const img = renderTag({ dictionary: CSCAN5_V1, id, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: 3, blurSigma: 0.8, seed: 100 + i })
    const truth = truthCorners(pose, K)
    const a = refined.detect(img).find((d) => d.id === id)
    const b = coarse.detect(img).find((d) => d.id === id)
    assert.ok(a, `frame ${i}: not detected with refinement`)
    withRefine.push(...cornerErrors(a.corners, truth))
    if (b) without.push(...cornerErrors(b.corners, truth))
  }
  const med = percentile(withRefine, 0.5)
  const p95 = percentile(withRefine, 0.95)
  assert.ok(med < 0.08, `median corner error ${med.toFixed(3)} px`)
  assert.ok(p95 < 0.25, `p95 corner error ${p95.toFixed(3)} px`)
  assert.ok(without.length >= 40, 'the unrefined detector should still read most of these')
  assert.ok(percentile(without, 0.5) > 3 * med, `without refinement the median error is ${percentile(without, 0.5).toFixed(3)} px against ${med.toFixed(3)} px with it`)
})

test('refinement survives sensor noise: corners are refined on nearly every read of a small tag at 8 and 12 levels of noise', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  // The edge scatter of a frame with 12 levels of noise is half a pixel. Judged against the scatter of a clean frame (0.1 px) the
  // samples of a noisy edge look like outliers, and an edge fit that did not widen its band to what the data show would refuse them.
  for (const [name, range, noise, blur, floor] of [['40 px', 2.5, 8, 1.0, 38], ['31 px', 3.2, 8, 1.0, 38], ['40 px', 2.5, 12, 1.4, 36], ['31 px', 3.2, 12, 1.4, 36]] as const) {
    const rand = mulberry32(range * 100 + noise * 7)
    let reads = 0
    let refined = 0
    let edgeRms = 0
    for (let i = 0; i < 40; i++) {
      const id = Math.floor(rand() * 32)
      const pose = tagPose({ x: (rand() - 0.5) * 0.4 * range, y: (rand() - 0.5) * 0.25 * range, z: range }, rand() * 360, (rand() - 0.5) * 80, (rand() - 0.5) * 50)
      const d = det.detect(renderTag({ dictionary: CSCAN5_V1, id, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: noise, blurSigma: blur, seed: i + 1, supersample: 2 })).find((x) => x.id === id)
      if (!d) continue
      reads++
      if (d.refined) {
        refined++
        edgeRms += d.edgeRmsPx!
      }
    }
    assert.equal(reads, 40, `${name} noise ${noise}: ${reads} of 40 read`)
    assert.ok(refined >= floor, `${name} noise ${noise}: ${refined} of ${reads} refined`)
    // The scatter the reads report is the noise the frames had, not the 0.1 px of a clean one.
    assert.ok(edgeRms / refined > (noise === 8 ? 0.12 : 0.3), `${name} noise ${noise}: mean edge scatter ${(edgeRms / refined).toFixed(3)} px`)
  }
})

test('the fields of a detection are the measurements they claim to be', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  const pose = tagPose({ x: 0.04, y: -0.02, z: 1.6 }, 25, 15, 5)
  const img = renderTag({ dictionary: CSCAN5_V1, id: 12, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: 1, blurSigma: 0.6, seed: 3 })
  const d = det.detect(img)[0]!
  const truth = truthCorners(pose, K)
  let side = 0
  for (let i = 0; i < 4; i++) side += Math.hypot(truth[(i + 1) % 4]!.x - truth[i]!.x, truth[(i + 1) % 4]!.y - truth[i]!.y)
  side /= 4
  assert.ok(Math.abs(d.sidePx - side) < 0.5, `side ${d.sidePx} px for a true ${side}`)
  // The paper is drawn at 225 and the ink at 25.
  assert.ok(Math.abs(d.contrast - 200) < 20, `contrast ${d.contrast}`)
  assert.equal(d.refined, true)
  assert.ok(d.edgeRmsPx !== null && d.edgeRmsPx < 0.3, `edge residual ${d.edgeRmsPx}`)
  assert.ok(d.quality > 0.7 && d.quality <= 1, `quality ${d.quality}`)
  assert.equal(d.level, 0)

  const unrefined = new FiducialDetector(CSCAN5_V1, { refineCorners: false }).detect(img)[0]!
  assert.equal(unrefined.refined, false)
  assert.equal(unrefined.edgeRmsPx, null)
  assert.ok(unrefined.quality < d.quality, 'an unrefined read ranks below a refined one')
})

test('quality ranks a clean read above a marginal one: contrast, bit errors and size all count, and it is a score between 0 and 1', () => {
  const lax = new FiducialDetector(CSCAN5_V1, { maxHamming: 2 })
  const pose = tagPose({ x: 0, y: 0, z: 1.4 }, 20, 10, 5)
  const frame = (extra: object = {}, flips: number[] = [], z = 1.4) => {
    const pattern = CSCAN5_V1.pattern(5).slice()
    for (const b of flips) pattern[b] = 1 - pattern[b]!
    return renderFrame({ width: 640, height: 480, intrinsics: K, items: [{ artwork: tagArtwork(pattern, 5, SIZE_M), pose: { ...pose, translation: { ...pose.translation, z } } }], noiseSigma: 1, seed: 3, ...extra })
  }
  const clean = lax.detect(frame())[0]!
  const oneFlip = lax.detect(frame({}, [4]))[0]!
  const twoFlips = lax.detect(frame({}, [4, 9]))[0]!
  const dim = lax.detect(frame({ exposure: { gain: 0.3, offset: 60 } }))[0]!
  const far = lax.detect(frame({}, [], 3.0))[0]!
  assert.deepEqual([clean.hamming, oneFlip.hamming, twoFlips.hamming], [0, 1, 2])
  assert.ok(clean.quality > oneFlip.quality && oneFlip.quality > twoFlips.quality, `${clean.quality} ${oneFlip.quality} ${twoFlips.quality}`)
  assert.ok(clean.quality > dim.quality, `a low-contrast read (${dim.contrast}) ranks below a clear one (${clean.contrast})`)
  assert.ok(dim.contrast < clean.contrast / 2)
  for (const d of [clean, oneFlip, twoFlips, dim, far]) assert.ok(d.quality > 0 && d.quality <= 1)
})

test('a tag below the contrast floor is refused with the reason counted, and the floor and threshold are the caller\'s to move', () => {
  const pose = tagPose({ x: 0, y: 0, z: 1.5 }, 30, 10, 5)
  const dim = renderTag({ dictionary: CSCAN5_V1, id: 5, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: 1, seed: 1, exposure: { gain: 0.1, offset: 100 } })
  const strict = new FiducialDetector(CSCAN5_V1)
  assert.deepEqual(strict.detect(dim), [], 'a tag printed and lit to a contrast of 20 levels is below what the defaults read')
  const patient = new FiducialDetector(CSCAN5_V1, { minContrast: 12, thresholdOffset: 3 })
  assert.equal(patient.detect(dim)[0]?.id, 5)
  assert.ok(patient.detect(dim)[0]!.contrast < 30)
  // The floor alone, with a frame the threshold stage still finds: the contrast test is what refuses it.
  const faint = renderTag({ dictionary: CSCAN5_V1, id: 5, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: 1, seed: 1, exposure: { gain: 0.15, offset: 100 } })
  const floorOnly = new FiducialDetector(CSCAN5_V1, { minContrast: 45, thresholdOffset: 3 })
  assert.deepEqual(floorOnly.detect(faint), [])
  assert.ok(floorOnly.stats.rejected.contrast >= 1, `rejections: ${JSON.stringify(floorOnly.stats.rejected)}`)
  assert.equal(new FiducialDetector(CSCAN5_V1, { minContrast: 12, thresholdOffset: 3 }).detect(faint)[0]?.id, 5)
})

test('RGBA, luma, padded rows and clamped arrays are read identically', () => {
  const pose = tagPose({ x: 0.06, y: -0.03, z: 1.8 }, 33, 20, 10)
  const base = renderTag({ dictionary: CSCAN5_V1, id: 9, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: 2, blurSigma: 0.6, seed: 8 })
  const rgba = renderTag({ dictionary: CSCAN5_V1, id: 9, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: 2, blurSigma: 0.6, seed: 8, channels: 4 })
  const reference = detectFiducials(base, CSCAN5_V1)
  assert.equal(reference.length, 1)

  // RGBA of the same grey pixels.
  const fromRgba = detectFiducials(rgba, CSCAN5_V1)
  assert.deepEqual(fromRgba.map((d) => d.corners), reference.map((d) => d.corners))

  // Luma with 17 bytes of padding on every row (8th Wall publishes rowBytes).
  const pad = 17
  const padded = new Uint8Array((K.width + pad) * K.height)
  for (let y = 0; y < K.height; y++) padded.set((base.data as Uint8Array).subarray(y * K.width, (y + 1) * K.width), y * (K.width + pad))
  const fromPadded = detectFiducials({ data: padded, width: K.width, height: K.height, channels: 1, rowBytes: K.width + pad }, CSCAN5_V1)
  assert.deepEqual(fromPadded.map((d) => d.corners), reference.map((d) => d.corners))

  // RGBA with padded rows, as a Uint8ClampedArray with a byte offset into a larger buffer.
  const rowBytes = K.width * 4 + 8
  const buffer = new ArrayBuffer(13 + rowBytes * K.height)
  const clamped = new Uint8ClampedArray(buffer, 13, rowBytes * K.height)
  for (let y = 0; y < K.height; y++) clamped.set((rgba.data as Uint8Array).subarray(y * K.width * 4, (y + 1) * K.width * 4), y * rowBytes)
  const fromClamped = detectFiducials({ data: clamped, width: K.width, height: K.height, channels: 4, rowBytes }, CSCAN5_V1)
  assert.deepEqual(fromClamped.map((d) => d.corners), reference.map((d) => d.corners))
})

test('the provider adapters map the two frame shapes, padded rows included, and refuse a row narrower than its format', () => {
  const rgba = new Uint8Array(8 * 6 * 4)
  const a = imageFromCameraPixelArray({ pixels: rgba, rows: 6, cols: 8, rowBytes: 32 })
  assert.deepEqual({ w: a.width, h: a.height, c: a.channels, r: a.rowBytes }, { w: 8, h: 6, c: 4, r: 32 })
  const luma = new Uint8Array(8 * 6)
  const b = imageFromCameraPixelArray({ pixels: luma, rows: 6, cols: 8, rowBytes: 8 })
  assert.deepEqual({ w: b.width, h: b.height, c: b.channels }, { w: 8, h: 6, c: 1 })
  // Without rowBytes the length says which it is.
  assert.equal(imageFromCameraPixelArray({ pixels: rgba, rows: 6, cols: 8 }).channels, 4)
  assert.equal(imageFromCameraPixelArray({ pixels: luma, rows: 6, cols: 8 }).channels, 1)
  // A padded row is the format it is padded from: 4 bytes of padding on an RGBA row of 8, 12 on a luma row of 8.
  const paddedRgba = imageFromCameraPixelArray({ pixels: new Uint8Array(36 * 6), rows: 6, cols: 8, rowBytes: 36 })
  assert.deepEqual({ c: paddedRgba.channels, r: paddedRgba.rowBytes }, { c: 4, r: 36 })
  const paddedLuma = imageFromCameraPixelArray({ pixels: new Uint8Array(20 * 6), rows: 6, cols: 8, rowBytes: 20 })
  assert.deepEqual({ c: paddedLuma.channels, r: paddedLuma.rowBytes }, { c: 1, r: 20 })
  assert.throws(() => imageFromCameraPixelArray({ pixels: rgba, rows: 6, cols: 8, rowBytes: 6 }), /narrower than 8 \(luma\) or 32 \(RGBA\)/)
  const raw = imageFromRawFrame({ pixels: new Uint8ClampedArray(8 * 6 * 4), width: 8, height: 6 })
  assert.deepEqual({ w: raw.width, h: raw.height, c: raw.channels }, { w: 8, h: 6, c: 4 })
  // A buffer too short for what it claims is refused, not read past.
  assert.throws(() => detectFiducials({ data: new Uint8Array(100), width: 64, height: 64, channels: 1 }, CSCAN5_V1), /cannot hold/)
})

test('detection rate over a noise, blur and exposure grid, at view angles up to about 45 degrees, with no wrong id anywhere', (t) => {
  const det = new FiducialDetector(CSCAN5_V1)
  const sizes: Array<[string, number]> = [['67 px', 1.5], ['40 px', 2.5], ['31 px', 3.2]]
  const exposures: Array<[string, object]> = [
    ['normal', {}],
    ['gain 0.4', { exposure: { gain: 0.4 } }],
    ['gamma 0.6 + shading', { exposure: { gamma: 0.6 }, shading: { gx: 0.6, gy: 0.3 } }],
  ]
  const N = 16
  let wrong = 0
  const rate = new Map<string, { ok: number; n: number }>()
  const add = (key: string, ok: boolean) => {
    const r = rate.get(key) ?? { ok: 0, n: 0 }
    r.n++
    if (ok) r.ok++
    rate.set(key, r)
  }
  for (const [sname, range] of sizes) {
    for (const [ename, extra] of exposures) {
      // Noise 12 at blur 1.4 is the harsh corner of the grid, run at normal exposure only to bound the cost.
      const conditions: Array<[number, number]> = [[0, 0], [0, 1.0], [4, 0], [4, 1.0], [8, 0], [8, 1.0], ...(ename === 'normal' ? ([[12, 1.4]] as Array<[number, number]>) : [])]
      for (const [noise, blur] of conditions) {
        const rand = mulberry32(range * 1000 + noise * 10 + blur * 3 + ename.length)
        for (let i = 0; i < N; i++) {
          const id = Math.floor(rand() * 32)
          const pose = tagPose({ x: (rand() - 0.5) * 0.4 * range, y: (rand() - 0.5) * 0.25 * range, z: range }, rand() * 360, (rand() - 0.5) * 80, (rand() - 0.5) * 50)
          const found = det.detect(renderTag({ dictionary: CSCAN5_V1, id, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: noise, blurSigma: blur, seed: i + 1, supersample: 3, ...extra }))
          if (found.some((d) => d.id !== id)) wrong++
          const hit = found.some((d) => d.id === id)
          add(`${sname} all`, hit)
          add(`${sname} ${ename}`, hit)
          add(`${sname} noise ${noise}`, hit)
          add(`${sname} blur ${blur}`, hit)
        }
      }
    }
  }
  const report = [...rate.entries()].map(([k, v]) => `${k}: ${v.ok}/${v.n}`).join('; ')
  t.diagnostic(report)
  assert.equal(wrong, 0, 'a tag was read as the wrong id')
  const frac = (key: string) => rate.get(key)!.ok / rate.get(key)!.n
  // Measured on this grid: every read, at every size. The bounds leave room for a platform's floating point, no more.
  assert.ok(frac('67 px all') >= 0.99, `67 px: ${frac('67 px all')}`)
  assert.ok(frac('40 px all') >= 0.98, `40 px: ${frac('40 px all')}`)
  assert.ok(frac('31 px all') >= 0.97, `31 px: ${frac('31 px all')}`)
  // Normal exposure is the common case; hold it tighter, noise 12 included (a noise-adaptive threshold was once in the
  // detector and cost a quarter of the 31 px reads there).
  for (const key of ['67 px normal', '40 px normal', '31 px normal']) assert.ok(frac(key) >= 0.98, `${key}: ${frac(key)}`)
  for (const key of ['40 px noise 12', '31 px noise 12']) assert.ok(frac(key) >= 0.95, `${key}: ${frac(key)}`)
})

test('a grid that is not a code is not reported, and it did reach the dictionary', () => {
  const rand = mulberry32(7)
  const det = new FiducialDetector(CSCAN5_V1)
  let reached = 0
  for (let i = 0; i < 24; i++) {
    // Far from every code: more than the correctable limit away from all of them.
    let pattern: Uint8Array
    do {
      pattern = new Uint8Array(25).map(() => (rand() < 0.5 ? 1 : 0))
    } while (CSCAN5_V1.match(pattern, CSCAN5_V1.maxCorrectableBits) !== null)
    const pose = tagPose({ x: 0, y: 0, z: 1.5 }, rand() * 360, (rand() - 0.5) * 40, (rand() - 0.5) * 30)
    const img = renderFrame({ width: 640, height: 480, intrinsics: K, items: [{ artwork: tagArtwork(pattern, 5, SIZE_M), pose }], noiseSigma: 2, seed: i })
    assert.deepEqual(det.detect(img), [], `grid ${i} was reported`)
    reached += det.stats.rejected.match
  }
  assert.ok(reached >= 20, `only ${reached} of 24 decoys reached the dictionary: the detector was rejecting them earlier`)
})

test('a tag from another family is not read, and is read by a detector for that family', () => {
  const words = searchFamily({ name: 'other-5x5', bits: 5, count: 32, minDistance: 9, minMirrorDistance: 0, minOnes: 7, maxOnes: 18, seed: 0x0de1, maxDraws: 6_000_000 })
  const other = createDictionary('other-5x5', 5, words)
  // The premise: the two families are far apart, so rejection is the dictionary's doing and not luck.
  let cross = Infinity
  for (let id = 0; id < other.size; id++) {
    const m = CSCAN5_V1.match(other.pattern(id), 25)
    if (m) cross = Math.min(cross, m.hamming)
  }
  assert.ok(cross > 2, `the second family has a code ${cross} bits from the first one`)
  const pose = tagPose({ x: 0.05, y: 0, z: 1.6 }, 40, 15, 5)
  const img = renderTag({ dictionary: other, id: 11, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: 2, seed: 3 })
  assert.deepEqual(detectFiducials(img, CSCAN5_V1, { maxHamming: 2 }), [])
  const own = detectFiducials(img, other)
  assert.equal(own.length, 1)
  assert.equal(own[0]!.id, 11)
  assert.equal(own[0]!.family, 'other-5x5')
})

test('bit errors up to the ceiling are read and reported; one more is rejected', () => {
  const pose = tagPose({ x: 0, y: 0, z: 1.2 }, 20, 10, 5)
  const withFlips = (id: number, flips: number[]) => {
    const pattern = CSCAN5_V1.pattern(id).slice()
    for (const b of flips) pattern[b] = 1 - pattern[b]!
    return renderFrame({ width: 640, height: 480, intrinsics: K, items: [{ artwork: tagArtwork(pattern, 5, SIZE_M), pose }], noiseSigma: 1, seed: 5 })
  }
  assert.equal(DEFAULT_MAX_HAMMING, 1)
  const strict = new FiducialDetector(CSCAN5_V1)
  const lax = new FiducialDetector(CSCAN5_V1, { maxHamming: 2 })
  assert.equal(strict.detect(withFlips(5, []))[0]?.hamming, 0)
  const one = strict.detect(withFlips(5, [3]))
  assert.equal(one[0]?.id, 5)
  assert.equal(one[0]?.hamming, 1)
  assert.deepEqual(strict.detect(withFlips(5, [3, 12])), [], 'two bit errors must not be read under a ceiling of one')
  assert.ok(strict.stats.rejected.match >= 1)
  const two = lax.detect(withFlips(5, [3, 12]))
  assert.equal(two[0]?.id, 5)
  assert.equal(two[0]?.hamming, 2)
  // A ceiling above what the family can correct is clamped, never trusted.
  assert.equal(new FiducialDetector(CSCAN5_V1, { maxHamming: 9 }).options.maxHamming, CSCAN5_V1.maxCorrectableBits)
})

test('ids restricts what is reported, and the rest are counted as turned away', () => {
  const items = [3, 19].map((id, i) => ({ artwork: dictionaryTagArtwork(CSCAN5_V1, id, SIZE_M), pose: tagPose({ x: i === 0 ? -0.4 : 0.4, y: 0, z: 2 }, 10 * i, 15, 0) }))
  const img = renderFrame({ width: 640, height: 480, intrinsics: K, items, noiseSigma: 2, seed: 2 })
  assert.deepEqual(detectFiducials(img, CSCAN5_V1).map((d) => d.id).sort((a, b) => a - b), [3, 19])
  const only = new FiducialDetector(CSCAN5_V1, { ids: [19] })
  assert.deepEqual(only.detect(img).map((d) => d.id), [19])
  assert.equal(only.stats.rejected.ids, 1)
  assert.deepEqual(new FiducialDetector(CSCAN5_V1, { ids: [4] }).detect(img), [])
})

test('several tags in one frame are all found, each once, best quality first', () => {
  const placed = [
    { id: 3, pose: tagPose({ x: -0.5, y: -0.1, z: 2 }, 10, 20, 0) },
    { id: 19, pose: tagPose({ x: 0.5, y: 0.1, z: 2.3 }, 200, -25, 10) },
    { id: 28, pose: tagPose({ x: 0, y: 0.5, z: 3 }, 90, 0, 0) },
  ]
  const img = renderFrame({
    width: 640,
    height: 480,
    intrinsics: K,
    items: placed.map((p) => ({ artwork: dictionaryTagArtwork(CSCAN5_V1, p.id, SIZE_M), pose: p.pose })),
    noiseSigma: 3,
    blurSigma: 0.7,
    seed: 4,
  })
  const found = detectFiducials(img, CSCAN5_V1)
  assert.deepEqual(found.map((d) => d.id).sort((a, b) => a - b), [3, 19, 28])
  for (const p of placed) {
    const d = found.find((f) => f.id === p.id)!
    assert.ok(Math.max(...cornerErrors(d.corners, truthCorners(p.pose, K))) < 0.4, `tag ${p.id} corners`)
  }
  for (let i = 1; i < found.length; i++) assert.ok(found[i - 1]!.quality >= found[i]!.quality)
})

test('noise-only frames and frames of rooms do not produce a tag, and they do exercise the decoder', (t) => {
  const det = new FiducialDetector(CSCAN5_V1)
  let frames = 0
  let detections = 0
  for (let i = 0; i < 80; i++) {
    const sigma = [1, 3, 6, 12, 25][i % 5]!
    detections += det.detect(noiseOnlyFrame(640, 480, 40 + ((i * 37) % 180), sigma, i + 1)).length
    frames++
  }
  const kinds: TextureKind[] = ['fractal', 'furniture', 'text', 'tiles', 'decoys']
  const attempts: Record<string, number> = {}
  for (const kind of kinds) {
    attempts[kind] = 0
    for (let i = 0; i < 30; i++) {
      const found = det.detect(textureFrame(kind, 640, 480, i + 1, CSCAN5_V1))
      detections += found.length
      attempts[kind]! += det.stats.decodeAttempts
      frames++
    }
  }
  t.diagnostic(`${frames} frames, ${detections} detections; decode attempts by kind: ${JSON.stringify(attempts)}`)
  assert.equal(detections, 0)
  // The structured kinds must have produced quads that were sampled and compared: that is the test's teeth.
  assert.ok(attempts['decoys']! >= 100, `decoys: ${attempts['decoys']} decode attempts`)
  assert.ok(attempts['furniture']! >= 40, `furniture: ${attempts['furniture']} decode attempts`)
  assert.ok(attempts['tiles']! >= 40, `tiles: ${attempts['tiles']} decode attempts`)
})

test('the decoder would be fooled by random grids if its ceiling were loosened, and is not at the default', (t) => {
  // Random 5x5 grids in a good-looking black square: unfiltered, so some land near a code by chance.
  const strict = new FiducialDetector(CSCAN5_V1)
  const loose = new FiducialDetector(CSCAN5_V1, { maxHamming: CSCAN5_V1.maxCorrectableBits })
  let squares = 0
  let strictHits = 0
  let looseHits = 0
  for (let i = 0; i < 40; i++) {
    const img = textureFrame('random-decoys', 640, 480, 500 + i, CSCAN5_V1)
    strictHits += strict.detect(img).length
    looseHits += loose.detect(img).length
    squares += strict.stats.decodeAttempts
  }
  t.diagnostic(`${squares} decode attempts: ${strictHits} detections at maxHamming ${DEFAULT_MAX_HAMMING}, ${looseHits} at ${CSCAN5_V1.maxCorrectableBits}`)
  assert.equal(strictHits, 0)
  assert.ok(looseHits >= 3, `only ${looseHits} false detections even at ceiling ${CSCAN5_V1.maxCorrectableBits}: the test is not reaching the matcher`)
})

test('the refinement window grows with the pyramid level and stays inside one cell', () => {
  // Far from a cell boundary (a 100 px cell): 2.25 px at full size, then 3.5, 6, 11 as the polygon comes from coarser levels.
  assert.deepEqual([0, 1, 2, 3].map((level) => refinementWindowPx(100, level)), [2.25, 3.5, 6, 11])
  // Never more than 0.9 of a cell, so the next boundary inside the tag is out of view.
  for (const level of [0, 1, 2, 3]) assert.ok(refinementWindowPx(3, level) <= 0.9 * 3 + 1e-12, `level ${level}`)
  assert.equal(refinementWindowPx(3, 3), 2.7)
  // Never shrinks as the level rises.
  for (const cell of [3, 8, 40]) for (let level = 0; level < 3; level++) assert.ok(refinementWindowPx(cell, level + 1) >= refinementWindowPx(cell, level))
})

test('a frame that is not a whole number of pixels is refused rather than read as something else', () => {
  assert.throws(() => detectFiducials({ data: new Uint8Array(100 * 100), width: 100.5, height: 100, channels: 1 }, CSCAN5_V1), /not a whole number of pixels/)
  assert.throws(() => detectFiducials({ data: new Uint8Array(100 * 100), width: 100, height: Number.NaN, channels: 1 }, CSCAN5_V1), /not a whole number of pixels/)
})

test('a tag cut by the frame edge, a tag below the minimum size and degenerate frames give nothing', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  const cut = renderTag({ dictionary: CSCAN5_V1, id: 4, sizeM: SIZE_M, pose: tagPose({ x: 1.0, y: 0, z: 1.5 }, 0, 0, 0), intrinsics: K, noiseSigma: 2, seed: 3 })
  assert.deepEqual(det.detect(cut), [])
  const tiny = renderTag({ dictionary: CSCAN5_V1, id: 4, sizeM: SIZE_M, pose: tagPose({ x: 0, y: 0, z: 6.5 }, 0, 0, 0), intrinsics: K, noiseSigma: 1, seed: 3 })
  assert.deepEqual(det.detect(tiny), [], 'a 15 px tag is below the 20 px minimum')
  // Allowing smaller tags is a choice the caller makes; it should not be a crash.
  assert.doesNotThrow(() => new FiducialDetector(CSCAN5_V1, { minSidePx: 12 }).detect(tiny))
  assert.deepEqual(det.detect({ data: new Uint8Array(8 * 8), width: 8, height: 8, channels: 1 }), [])
  assert.deepEqual(det.detect({ data: new Uint8Array(640 * 480).fill(120), width: 640, height: 480, channels: 1 }), [])
  assert.deepEqual(det.detect({ data: new Uint8Array(640 * 480), width: 640, height: 480, channels: 1 }), [])
})

test('tags from far to filling most of the frame are read, on 640x480 luma and 1280x960 RGBA', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  for (const z of [0.7, 0.45, 0.35]) {
    const found = det.detect(renderTag({ dictionary: CSCAN5_V1, id: 4, sizeM: SIZE_M, pose: tagPose({ x: 0, y: 0, z }, 15, 10, 5), intrinsics: K, noiseSigma: 2, blurSigma: 0.6, seed: 3 }))
    assert.equal(found.length, 1, `z ${z}`)
    assert.equal(found[0]!.id, 4)
    assert.ok(found[0]!.sidePx > 140, `side ${found[0]!.sidePx}`)
  }
  for (const z of [1.4, 0.8, 0.7]) {
    const found = det.detect(renderTag({ dictionary: CSCAN5_V1, id: 4, sizeM: SIZE_M, pose: tagPose({ x: 0, y: 0, z }, 15, 10, 5), intrinsics: INTRINSICS_1280, noiseSigma: 2, blurSigma: 0.6, seed: 3, channels: 4 }))
    assert.equal(found.length, 1, `1280 z ${z}`)
    assert.equal(found[0]!.id, 4)
    // A 1.2 Mpixel frame is searched from a halved level, and the corners are still sub-pixel at full size.
    assert.ok(found[0]!.level >= 1, `found at level ${found[0]!.level}`)
    assert.equal(found[0]!.refined, true)
  }
})

test('the detector reuses its buffers across frames and across frame sizes without carrying anything over', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  const a = renderTag({ dictionary: CSCAN5_V1, id: 6, sizeM: SIZE_M, pose: tagPose({ x: 0, y: 0, z: 2 }, 5, 10, 0), intrinsics: K, noiseSigma: 2, seed: 1 })
  const b = renderTag({ dictionary: CSCAN5_V1, id: 21, sizeM: SIZE_M, pose: tagPose({ x: 0.1, y: 0, z: 3.5 }, 50, 10, 0), intrinsics: INTRINSICS_1280, noiseSigma: 2, seed: 2 })
  const empty = noiseOnlyFrame(640, 480, 120, 3, 9)
  const first = det.detect(a).map((d) => d.id)
  assert.deepEqual(det.detect(b).map((d) => d.id), [21])
  assert.deepEqual(det.detect(empty), [])
  assert.deepEqual(det.detect(a).map((d) => d.id), first)
  assert.deepEqual(first, [6])
})

test('random frames of every size and kind never throw, never give a non-finite number, and never give a wrong id', () => {
  const rand = mulberry32(12345)
  const det = new FiducialDetector(CSCAN5_V1, { maxHamming: 2 })
  const kinds: TextureKind[] = ['fractal', 'furniture', 'text', 'tiles', 'decoys', 'random-decoys']
  let hits = 0
  let tagFrames = 0
  let chanceReads = 0
  for (let i = 0; i < 400; i++) {
    const w = 16 + Math.floor(rand() * 700)
    const h = 16 + Math.floor(rand() * 600)
    const kind = i % 6
    let img: FiducialImage
    let expected = -1
    if (kind === 0) {
      const d = new Uint8Array(w * h)
      for (let j = 0; j < d.length; j++) d[j] = (rand() * 256) | 0
      img = { data: d, width: w, height: h, channels: 1 }
    } else if (kind === 1) {
      const d = new Uint8Array(w * h * 4)
      for (let j = 0; j < d.length; j += 4) {
        const v = rand() < 0.5 ? 0 : 255
        d[j] = v
        d[j + 1] = v
        d[j + 2] = v
        d[j + 3] = 255
      }
      img = { data: d, width: w, height: h, channels: 4 }
    } else if (kind === 2) {
      img = { data: new Uint8Array(w * h).fill((rand() * 256) | 0), width: w, height: h, channels: 1 }
    } else if (kind === 3) {
      // A real tag at a random scale, place and tilt in a random frame size, often clipped or too small or too oblique to read.
      const W = Math.max(64, w)
      const H = Math.max(64, h)
      const f = 300 + rand() * 600
      expected = Math.floor(rand() * 32)
      const pose = tagPose({ x: (rand() - 0.5) * 2, y: (rand() - 0.5) * 1.5, z: 0.3 + rand() * 5 }, rand() * 360, (rand() - 0.5) * 140, (rand() - 0.5) * 120)
      img = renderTag({ dictionary: CSCAN5_V1, id: expected, sizeM: SIZE_M, pose, intrinsics: { fx: f, fy: f, cx: W / 2, cy: H / 2, width: W, height: H }, noiseSigma: rand() * 10, blurSigma: rand() * 2, seed: i, supersample: 2, channels: rand() < 0.5 ? 1 : 4 })
    } else {
      img = textureFrame(kinds[i % kinds.length]!, Math.max(64, w), Math.max(64, h), i, CSCAN5_V1)
    }
    const found = det.detect(img)
    if (kind === 3) tagFrames++
    for (const d of found) {
      assert.ok(d.corners.every((c) => Number.isFinite(c.x) && Number.isFinite(c.y)), `frame ${i}: non-finite corner`)
      assert.ok([d.quality, d.sidePx, d.contrast].every(Number.isFinite), `frame ${i}: non-finite field`)
      assert.ok(Number.isInteger(d.id) && d.id >= 0 && d.id < 32, `frame ${i}: id ${d.id}`)
      if (kind === 3) {
        assert.equal(d.id, expected, `frame ${i}: a tag was read as the wrong id`)
        hits++
      } else if (kind === 5) {
        // Random 5x5 grids are within two bits of a code about once in 800 times, which is what a ceiling of two bits means: a
        // detection here is a false accept at the documented rate, and the fields it reports must still be sound.
        chanceReads++
      } else {
        assert.fail(`frame ${i} (kind ${kind}): a tag was reported in a frame with none`)
      }
      const sol = solveTagPose(d.corners, { fx: 500, fy: 500, cx: w / 2, cy: h / 2, width: w, height: h }, SIZE_M)
      if (sol) assert.ok(Number.isFinite(sol.best.rangeM) && Number.isFinite(sol.best.reprojectionRmsPx), `frame ${i}: non-finite pose`)
    }
  }
  assert.ok(hits >= 10, `only ${hits} of ${tagFrames} tag frames were read: the fuzz is not reaching the decoder`)
  // 67 frames of random grids at about 6 squares each and 1 in 800 each: about half a chance read expected; a dozen would be a leak.
  assert.ok(chanceReads <= 4, `${chanceReads} random grids were read as tags at two bits`)
})

test('detector cost per frame (reported, bounded loosely)', (t) => {
  const det = new FiducialDetector(CSCAN5_V1)
  const frames: Array<[string, FiducialImage]> = [
    ['640x480 luma, tag at 2 m', renderTag({ dictionary: CSCAN5_V1, id: 3, sizeM: SIZE_M, pose: tagPose({ x: 0.05, y: 0.02, z: 2 }, 20, 15, 10), intrinsics: K, noiseSigma: 3, blurSigma: 0.7, seed: 2 })],
    ['640x480 RGBA, tag at 2 m', renderTag({ dictionary: CSCAN5_V1, id: 3, sizeM: SIZE_M, pose: tagPose({ x: 0.05, y: 0.02, z: 2 }, 20, 15, 10), intrinsics: K, noiseSigma: 3, blurSigma: 0.7, seed: 2, channels: 4 })],
    ['640x480 luma, no tag (noise)', noiseOnlyFrame(640, 480, 120, 3, 4)],
    ['640x480 luma, cluttered room', textureFrame('decoys', 640, 480, 3, CSCAN5_V1)],
    ['1280x960 luma, tag at 4 m', renderTag({ dictionary: CSCAN5_V1, id: 3, sizeM: SIZE_M, pose: tagPose({ x: 0.1, y: 0.05, z: 4 }, 20, 15, 10), intrinsics: INTRINSICS_1280, noiseSigma: 3, blurSigma: 0.7, seed: 2 })],
  ]
  const lines: string[] = []
  for (const [name, img] of frames) {
    const cost = measureDetectorCost(det, img, { warmup: 30, runs: 60 })
    assert.equal(cost.runs, 60)
    assert.ok(cost.minMs <= cost.medianMs && cost.medianMs <= cost.p95Ms)
    lines.push(`${name}: median ${cost.medianMs.toFixed(2)} ms, p95 ${cost.p95Ms.toFixed(2)} ms`)
    // A gross regression (an accidental O(n^2), a per-pixel allocation) shows up long before this bound; a slow CI box does not reach it.
    assert.ok(cost.medianMs < 80, `${name}: median ${cost.medianMs} ms`)
  }
  t.diagnostic(lines.join(' | '))
})

// ---------------------------------------------------------------------------------------------
// Steep views, a busy wall, the way candidates are grouped, light that is not even, options, colour
// ---------------------------------------------------------------------------------------------

/** Longest side and longest diagonal of the tag's black square as it lands in the image, pixels. */
function sideAndDiagonal(pose: RigidPose, k: CameraIntrinsics): { side: number; diagonal: number } {
  const c = truthCorners(pose, k)
  const d = (i: number, j: number) => Math.hypot(c[i]!.x - c[j]!.x, c[i]!.y - c[j]!.y)
  return { side: Math.max(d(0, 1), d(1, 2), d(2, 3), d(3, 0)), diagonal: Math.max(d(0, 2), d(1, 3)) }
}

test('a tag seen very obliquely is read, including views in which one side is longer than either diagonal', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  let steep = 0
  let reads = 0
  // About an axis parallel to an edge is the worst case. At 0.75 m a 20 cm tag is 123 px across face-on. The corner
  // choice that assumed the two farthest points of the outline are opposite corners lost these tags from about 62 degrees.
  for (const [range, yaws] of [[0.75, [60, 65, 70, 75]], [1.0, [65, 70, 74]]] as const) {
    for (const yaw of yaws) {
      for (const [spin, pitch] of [[0, 0], [90, 0], [37, 8], [200, -8]] as const) {
        const pose = tagPose({ x: 0.03, y: 0.02, z: range }, spin, yaw, pitch)
        const { side, diagonal } = sideAndDiagonal(pose, K)
        if (side > diagonal) steep++
        const id = (yaw + spin) % 32
        const found = det.detect(renderTag({ dictionary: CSCAN5_V1, id, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: 3, blurSigma: 0.7, seed: yaw + spin, supersample: 3 })).filter((d) => d.id === id)
        assert.equal(found.length, 1, `range ${range} yaw ${yaw} spin ${spin} pitch ${pitch}: not read`)
        reads++
        const err = Math.max(...cornerErrors(found[0]!.corners, truthCorners(pose, K)))
        assert.ok(err < 0.7, `range ${range} yaw ${yaw} spin ${spin}: corners ${err.toFixed(2)} px out`)
      }
    }
  }
  assert.equal(reads, 28)
  assert.ok(steep >= 8, `only ${steep} of the views had a side longer than a diagonal: the test is not reaching the case it is for`)
})

/** A frame of `count` black squares larger than the tag, each with a white margin on a mid-grey wall, and one tag 40 px across. */
function busyWall(kind: 'solid' | 'frame' | 'pseudo', count: number, trial: number): { image: FiducialImage; id: number } {
  const rand = mulberry32(1000 * trial + count + 7)
  const f = K.fx
  const cols = 8
  const rows = 6
  const slots = Array.from({ length: cols * rows }, (_, i) => i)
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[slots[i], slots[j]] = [slots[j]!, slots[i]!]
  }
  const at = (slot: number, jitter: number) => ({ x: ((slot % cols) + 0.5) * (640 / cols) + (rand() - 0.5) * jitter, y: (Math.floor(slot / cols) + 0.5) * (480 / rows) + (rand() - 0.5) * jitter })
  const items: PlacedArtwork[] = []
  const z = 2
  for (let k = 0; k < count; k++) {
    const sidePx = 44 + rand() * 18
    const side = (sidePx * z) / f
    const pattern = kind === 'solid' ? new Uint8Array(25).fill(1) : kind === 'frame' ? new Uint8Array(25) : randomNonCode(5, rand, CSCAN5_V1)
    const c = at(slots[1 + k]!, 6)
    items.push({ artwork: tagArtwork(pattern, 5, side), pose: tagPose({ x: ((c.x - K.cx) * z) / f, y: ((c.y - K.cy) * z) / f, z }, 0, 0, 0) })
  }
  const id = (trial * 5 + 3) % 32
  const tagZ = (f * SIZE_M) / 38
  const c = at(slots[0]!, 0)
  items.push({ artwork: dictionaryTagArtwork(CSCAN5_V1, id, SIZE_M), pose: tagPose({ x: ((c.x - K.cx) * tagZ) / f, y: ((c.y - K.cy) * tagZ) / f, z: tagZ }, 10 * trial, 0, 0) })
  return { image: renderFrame({ width: 640, height: 480, intrinsics: K, items, background: 125, noiseSigma: 3, blurSigma: 0.7, seed: trial + count, supersample: 2 }), id }
}

test('a tag among dozens of larger black squares is still found: what looks like a tag is decoded first, and the frame is said to be too busy', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  for (const kind of ['solid', 'frame', 'pseudo'] as const) {
    for (const count of [25, 40]) {
      let read = 0
      for (let trial = 0; trial < 3; trial++) {
        const { image, id } = busyWall(kind, count, trial)
        const found = det.detect(image)
        assert.ok(found.every((d) => d.id === id), `${kind} x${count}: a wrong id`)
        if (found.some((d) => d.id === id)) read++
        // More quads than the budget can decode: the cheap look is what put the tag in reach.
        assert.ok(det.stats.candidates > det.options.maxCandidates, `${kind} x${count}: ${det.stats.candidates} candidates`)
        assert.ok(det.stats.prechecked >= det.stats.groups, `${kind} x${count}: ${det.stats.prechecked} of ${det.stats.groups} groups looked at`)
        assert.ok(det.stats.decodeAttempts <= det.options.maxCandidates)
        assert.equal(det.stats.capped, true, `${kind} x${count}: the budget ran out and the frame did not say so`)
      }
      assert.equal(read, 3, `${kind} x${count}: the tag was read in ${read} of 3 frames`)
    }
  }
})

test('the decode budget is what keeps a busy frame cheap: it holds, it is reported, and its default is a sensible size', () => {
  // A wall of dark tiles with light grout, 30 px tiles: hundreds of quads and no tag in it.
  const tiles = new Uint8Array(640 * 480)
  for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) tiles[y * 640 + x] = x % 36 < 30 && y % 36 < 30 ? 40 : 205
  const wall: FiducialImage = { data: tiles, width: 640, height: 480, channels: 1 }
  const det = new FiducialDetector(CSCAN5_V1)
  assert.deepEqual(det.detect(wall), [])
  assert.ok(det.stats.candidates > 3 * DEFAULT_MAX_CANDIDATES, `${det.stats.candidates} candidates`)
  assert.equal(det.stats.decodeAttempts, DEFAULT_MAX_CANDIDATES)
  assert.equal(det.stats.capped, true)
  const small = new FiducialDetector(CSCAN5_V1, { maxCandidates: 12 })
  small.detect(wall)
  assert.equal(small.stats.decodeAttempts, 12)
  // A frame with a handful of quads is never capped.
  const quiet = new FiducialDetector(CSCAN5_V1)
  quiet.detect(renderTag({ dictionary: CSCAN5_V1, id: 4, sizeM: SIZE_M, pose: tagPose({ x: 0, y: 0, z: 1.5 }, 10, 10, 5), intrinsics: K, noiseSigma: 2, seed: 1 }))
  assert.equal(quiet.stats.capped, false)
  assert.equal(quiet.stats.prechecked, 0, 'the cheap look is only for frames with more quads than the budget')
  // About 0.2 ms a decode on a laptop: below 32 a real tag in a busy room can be starved, above 128 the worst case on a phone is a visible stall.
  assert.ok(DEFAULT_MAX_CANDIDATES >= 32 && DEFAULT_MAX_CANDIDATES <= 128, `the default decode budget is ${DEFAULT_MAX_CANDIDATES}`)
})

/** A square quad candidate at `(x, y)` with side `side`, turned `turn` radians. */
function square(x: number, y: number, side: number, turn: number, level: number): Candidate {
  const h = side / 2
  const corners = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([u, v]) => ({ x: x + u! * Math.cos(turn) - v! * Math.sin(turn), y: y + u! * Math.sin(turn) + v! * Math.cos(turn) }))
  return { corners, area: side * side, level, disputed: false }
}

/** The grouping written the obvious way, comparing every candidate with every group: the specification the fast one must meet. */
function naiveGroups(candidates: Candidate[]): Candidate[][] {
  const centre = (c: Candidate) => ({ x: c.corners.reduce((s, p) => s + p.x, 0) / 4, y: c.corners.reduce((s, p) => s + p.y, 0) / 4 })
  const side = (c: Candidate) => c.corners.reduce((s, p, i) => s + Math.hypot(c.corners[(i + 1) % 4]!.x - p.x, c.corners[(i + 1) % 4]!.y - p.y), 0) / 4
  const same = (a: Candidate, b: Candidate) => {
    const ca = centre(a)
    const cb = centre(b)
    return Math.hypot(ca.x - cb.x, ca.y - cb.y) < 0.3 * Math.min(side(a), side(b)) && side(a) / side(b) > 0.7 && side(a) / side(b) < 1.43
  }
  const groups: Candidate[][] = []
  for (const c of candidates.slice().sort((a, b) => b.area - a.area)) {
    const g = groups.find((x) => same(x[0]!, c))
    if (g) g.push(c)
    else groups.push([c])
  }
  for (const g of groups) g.sort((a, b) => a.level - b.level || b.area - a.area)
  return groups
}

test('grouping candidates by place gives the groups the all-pairs comparison gives, and costs about as much per candidate however many there are', () => {
  const rand = mulberry32(21)
  for (const [n, spread] of [[40, 200], [300, 600], [600, 120]] as const) {
    const candidates: Candidate[] = []
    for (let i = 0; i < n; i++) {
      // Tags and their halos at neighbouring pyramid levels: the same place at 1x, 2x and 4x the scale, sometimes a little off.
      const x = 20 + rand() * spread
      const y = 20 + rand() * spread
      const side = 12 + rand() * 150
      const turn = rand() * 1.5
      candidates.push(square(x, y, side, turn, 0))
      if (rand() < 0.7) candidates.push(square(x + (rand() - 0.5) * 0.3 * side, y + (rand() - 0.5) * 0.3 * side, side * (0.75 + rand() * 0.6), turn, 1))
      if (rand() < 0.4) candidates.push(square(x + (rand() - 0.5) * 0.5 * side, y, side * (0.6 + rand()), turn, 2))
    }
    // Distinct areas, so that "largest first" is a strict order both implementations agree on.
    candidates.forEach((c, i) => (c.area += i * 1e-6))
    const fast = groupCandidates(candidates)
    const slow = naiveGroups(candidates)
    assert.equal(fast.length, slow.length, `${n} places: ${fast.length} groups against ${slow.length}`)
    for (let g = 0; g < slow.length; g++) assert.deepEqual(fast[g]!.map((c) => candidates.indexOf(c)), slow[g]!.map((c) => candidates.indexOf(c)), `group ${g}`)
  }
  // 6000 candidates in a grid, none alike: the all-pairs comparison would make 18 million comparisons of eight square roots each.
  const grid: Candidate[] = []
  for (let i = 0; i < 6000; i++) grid.push(square(10 + (i % 100) * 12, 10 + Math.floor(i / 100) * 12, 9 + (i % 3), 0, 0))
  grid.forEach((c, i) => (c.area += i * 1e-6))
  const t0 = performance.now()
  const groups = groupCandidates(grid)
  const ms = performance.now() - t0
  assert.equal(groups.length, 6000)
  assert.ok(ms < 100, `grouping 6000 candidates took ${ms.toFixed(0)} ms`)
})

/** Lighting that falls from 1 at one side of the tag to `1 / ratio` at the other over `edgePx` pixels, across a line through the tag's centre at `angle`. */
function lightAcrossTag(centre: { x: number; y: number }, ratio: number, angle: number, edgePx: number): (x: number, y: number) => number {
  return (x, y) => {
    const s = (x - centre.x) * Math.cos(angle) + (y - centre.y) * Math.sin(angle)
    const t = Math.max(0, Math.min(1, (s + edgePx / 2) / edgePx))
    return 1 - (1 - 1 / ratio) * t
  }
}

function litTagReads(det: FiducialDetector, ratio: number, edgeOf: (tagPx: number) => number, trials: number, seed: number): { read: number; wrong: number; refined: number } {
  const rand = mulberry32(seed)
  let read = 0
  let wrong = 0
  let refined = 0
  for (let i = 0; i < trials; i++) {
    const id = Math.floor(rand() * 32)
    const z = 1.55
    const pose = tagPose({ x: (rand() - 0.5) * 0.2, y: (rand() - 0.5) * 0.15, z }, rand() * 360, (rand() - 0.5) * 30, (rand() - 0.5) * 20)
    const tagPx = (K.fx * SIZE_M) / z
    const centre = { x: (K.fx * pose.translation.x) / z + K.cx, y: (K.fy * pose.translation.y) / z + K.cy }
    const found = det.detect(renderTag({ dictionary: CSCAN5_V1, id, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: 3, blurSigma: 0.7, seed: i + 1, supersample: 2, light: lightAcrossTag(centre, ratio, rand() * 2 * Math.PI, edgeOf(tagPx)) }))
    if (found.some((d) => d.id !== id)) wrong++
    const hit = found.find((d) => d.id === id)
    if (hit) {
      read++
      if (hit.refined) refined++
    }
  }
  return { read, wrong, refined }
}

test('light that changes across the tag is read: a gradient from one side to the other up to 16:1, and a soft shadow of 3:1; a hard one is not, and is not misread', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  // A gradient across the whole tag. One threshold for the tag cannot read it past about 2:1 (the paper at the dim end is darker than
  // halfway between the tag's black and white); the levels fitted across the tag read it far past that, with no wrong id.
  for (const ratio of [3, 4, 6, 12, 16]) {
    const r = litTagReads(det, ratio, (px) => px, 24, 100 + ratio)
    assert.equal(r.wrong, 0, `gradient ${ratio}:1`)
    assert.ok(r.read >= 23, `gradient ${ratio}:1: ${r.read} of 24 read`)
    // Corners good enough for a pose need every edge to show a step of at least the contrast floor (30 levels) along most of its length,
    // which the dim end of a steep gradient does not: the tag is read there, and its corners are not called refined.
    if (ratio <= 4) assert.ok(r.refined >= 22, `gradient ${ratio}:1: ${r.refined} of 24 refined`)
    if (ratio >= 12) assert.ok(r.refined <= 4, `gradient ${ratio}:1: ${r.refined} of 24 refined, with an edge step of ${Math.round(200 / ratio)} levels at the dim end`)
  }
  // The middle of the tag sets the contrast, not its dimmest end: at 16:1 the dim end has 12 levels between ink and paper, under the floor of 30, and the tag reads.
  assert.equal(det.stats.rejected.contrast, 0)
  // A shadow with a penumbra 20 % of the tag wide: a hand, a lamp shade.
  const soft = litTagReads(det, 3, (px) => 0.2 * px, 24, 200)
  assert.equal(soft.wrong, 0)
  assert.ok(soft.read >= 23, `soft shadow 3:1: ${soft.read} of 24 read`)
  // A shadow with an edge only 2 px wide across the middle of the tag, at 3:1, was read in 15 % of frames (12 of 80) by one threshold for the
  // tag. It is read in about three of five now; what is left is the polygon stage, which sees dim paper beside lit paper as dark.
  const hard3 = litTagReads(det, 3, () => 2, 24, 250)
  assert.equal(hard3.wrong, 0)
  assert.ok(hard3.read >= 12, `hard shadow 3:1: ${hard3.read} of 24 read`)
  // A shadow with a hard edge across the tag at 4:1 is more than the polygon stage can take (the dim paper beside the lit paper looks dark
  // to the adaptive threshold and joins the tag's border): nothing is read, and nothing is misread.
  const hard = litTagReads(det, 4, () => 2, 12, 300)
  assert.equal(hard.wrong, 0)
  assert.ok(hard.read <= 2, `hard shadow 4:1: ${hard.read} of 12 read`)
})

test('options that are not numbers in range are refused, not run: NaN made every bordered square a tag', () => {
  const bad: Array<Record<string, unknown>> = [
    { maxHamming: Number.NaN }, { maxHamming: -1 }, { maxHamming: 1.5 }, { maxHamming: Infinity },
    { minSidePx: 0 }, { minSidePx: Number.NaN }, { maxDetectPixels: 100 }, { maxDetectPixels: Number.NaN },
    { levels: 0 }, { levels: 3.5 }, { levels: 99 }, { levels: Number.NaN },
    { thresholdRadius: 0 }, { thresholdRadius: 2.5 }, { thresholdOffset: -1 }, { thresholdOffset: Number.NaN },
    { minContrast: -1 }, { minContrast: 256 }, { minContrast: Number.NaN },
    { maxBorderErrors: Number.NaN }, { maxBorderErrors: -1 }, { maxBorderErrors: 25 }, { maxQuietErrors: Number.NaN }, { maxQuietErrors: 29 },
    { maxCandidates: 0 }, { maxCandidates: Number.NaN }, { maxCandidates: 2.5 },
    { ids: [32] }, { ids: [-1] }, { ids: [1.5] }, { ids: [Number.NaN] },
  ]
  for (const options of bad) assert.throws(() => new FiducialDetector(CSCAN5_V1, options as never), RangeError, JSON.stringify(options))
  assert.throws(() => new FiducialDetector(CSCAN5_V1, { maxHamming: Number.NaN }), /maxHamming: NaN is not a whole number from 0 to/)
  // The extremes that are legal, and a ceiling above what the family corrects is clamped as before.
  for (const options of [{ maxHamming: 0 }, { maxHamming: 4 }, { maxBorderErrors: 24 }, { maxQuietErrors: 28 }, { minContrast: 0 }, { minContrast: 255 }, { levels: 8 }, { ids: [0, 31] }, { ids: [] }]) {
    assert.doesNotThrow(() => new FiducialDetector(CSCAN5_V1, options), JSON.stringify(options))
  }
  assert.equal(new FiducialDetector(CSCAN5_V1, { maxHamming: 99 }).options.maxHamming, CSCAN5_V1.maxCorrectableBits)
  // The failure the check exists for: the same square-with-a-border frames that are refused by default are accepted wholesale by NaN.
  const rand = mulberry32(3)
  const squares: FiducialImage[] = []
  for (let i = 0; i < 6; i++) {
    const pattern = randomNonCode(5, rand, CSCAN5_V1)
    squares.push(renderFrame({ width: 640, height: 480, intrinsics: K, items: [{ artwork: tagArtwork(pattern, 5, SIZE_M), pose: tagPose({ x: 0, y: 0, z: 1.5 }, 20 * i, 10, 5) }], noiseSigma: 2, seed: i + 1 }))
  }
  const normal = new FiducialDetector(CSCAN5_V1)
  for (const img of squares) assert.deepEqual(normal.detect(img), [])
})

/** A frame of the tag in three colour channels: ink and paper as RGB triples. */
function colourFrame(ink: [number, number, number], paper: [number, number, number]): FiducialImage {
  const pose = tagPose({ x: 0.03, y: -0.02, z: 1.4 }, 25, 12, 6)
  const planes = [0, 1, 2].map((c) => renderTag({ dictionary: CSCAN5_V1, id: 6, sizeM: SIZE_M, pose, intrinsics: K, tag: { ink: ink[c]!, paper: paper[c]! }, background: paper[c]!, blurSigma: 0.5, supersample: 2 }).data)
  const out = new Uint8Array(640 * 480 * 4)
  for (let i = 0; i < 640 * 480; i++) {
    out[4 * i] = planes[0]![i]!
    out[4 * i + 1] = planes[1]![i]!
    out[4 * i + 2] = planes[2]![i]!
    out[4 * i + 3] = 255
  }
  return { data: out, width: 640, height: 480, channels: 4 }
}

test('colour frames are turned to grey by the standard weights: green outweighs red outweighs blue', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  const red: [number, number, number] = [255, 0, 0]
  const green: [number, number, number] = [0, 255, 0]
  const blue: [number, number, number] = [0, 0, 255]
  // Luma 0.299 R + 0.587 G + 0.114 B: green paper is 150, red ink 77: a tag. Red paper is 77, blue ink 29: a tag, with less to spare.
  assert.equal(det.detect(colourFrame(red, green))[0]?.id, 6, 'red ink on green paper')
  assert.equal(det.detect(colourFrame(blue, red))[0]?.id, 6, 'blue ink on red paper')
  // Blue paper is 29 and green ink 150: the ink is the lighter, which is not a tag.
  assert.deepEqual(det.detect(colourFrame(green, blue)), [], 'green ink on blue paper')
  // And black on white in colour is the same tag as in grey.
  const grey = renderTag({ dictionary: CSCAN5_V1, id: 6, sizeM: SIZE_M, pose: tagPose({ x: 0.03, y: -0.02, z: 1.4 }, 25, 12, 6), intrinsics: K, blurSigma: 0.5, supersample: 2 })
  assert.equal(det.detect(grey)[0]?.id, 6)
})
