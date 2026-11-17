/**
 * What a session's keyframe records say about where its camera was, in the shapes the joint solve and the chain
 * back to the Place frame read them.
 *
 * A keyframe record carries the AR pose the phone had when it took the frame: a camera-to-world pose in the
 * session's own frame (the frame its runtime started in, in its own units), the runtime's epoch number and the
 * lens it reported. Three readers need those, and each needs the same few decisions made the same way, so they are
 * made here once (ADR 0001):
 *
 *  - **Which frames.** A session's frames are in one coordinate frame only while the runtime's tracking holds
 *    (src/ar/frame-epoch.ts: an epoch ends at a loss, a relocalization, a resume or a recentre). The calibration
 *    (`sessionToProject`) was made in one epoch, the scan's `calibrationEpoch`, and says nothing about the frames of
 *    another. So the poses a pair list gates on, and the centres the per-session similarity is fitted to, come from
 *    one epoch only. See {@link chooseSessionEpoch}.
 *  - **What a frame is called.** COLMAP knows an image by its path under the image root, `<sessionId>/kf-00012.jpg`,
 *    and that string is the key of `colmap.poses.json`, of `sfmCentresFromPoses`, of the pair list and of
 *    {@link sessionCentres}. `pairByFilename` in splat_align.ts pairs two maps by their keys, so giving both sides the
 *    same key scheme is what makes it pair the right frames. See {@link frameKey}.
 *  - **Where in the Place frame.** A pair list gates on camera centres and viewing directions in the Place frame,
 *    which is where the session's `sessionToProject` (column-major, as THREE writes it) takes the session frame.
 *    See {@link pairImagesFromKeyframes}.
 *
 * Pure: records in, plain values out.
 */
import { applyColumnMajor, metricCentresFromKeyframes, type Vec3Tuple } from '../splat/splat_align.ts'
import { type KeyframeRecord, poseToMatrix, recordHasPose } from '../splat/splat_train_dataset.ts'
import type { PairImage } from './pair_list.ts'
import { sim3FromColumnMajor } from './sim3_chain.ts'

/** The key a frame goes by through a joint solve: its COLMAP image name, the path under the image root. */
export function frameKey(folder: string, file: string): string {
  return `${folder}/${file}`
}

/** The folder part of a {@link frameKey}, or null for a key with no folder. */
export function folderOfKey(key: string): string | null {
  const at = key.lastIndexOf('/')
  return at > 0 ? key.slice(0, at) : null
}

/**
 * The records with `file` replaced by the frame key, so a reader that pairs or groups by filename
 * (`metricCentresFromKeyframes`, `viewpointsFromKeyframes`, `pairByFilename`) works on the joint layout unchanged.
 * A record with no usable `file` is left out.
 */
export function keyedRecords(records: readonly KeyframeRecord[], folder: string): KeyframeRecord[] {
  const out: KeyframeRecord[] = []
  for (const record of records) {
    if (typeof record.file !== 'string' || record.file === '') continue
    out.push({ ...record, file: frameKey(folder, record.file) })
  }
  return out
}

/**
 * The epoch a record was taken in. A record with none (a session streamed by a build from before epochs, or a
 * provider with no signal) is in epoch 0, which is what the streamer writes for a provider that never reports one.
 */
export function recordEpoch(record: KeyframeRecord): number {
  const raw = (record as Record<string, unknown>)['epoch']
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0
}

export interface SessionEpochChoice {
  /** The epoch the poses are read from, or null when no frame carries a pose. */
  epoch: number | null
  /**
   * `'calibration'`: the caller named the epoch the calibration was made in, which is the only epoch
   * `sessionToProject` is valid for. `'majority'`: nothing was named, so the epoch with the most posed frames, the
   * lowest on a tie; the chain it feeds is only as good as that guess. `'none'`: no posed frame.
   */
  source: 'calibration' | 'majority' | 'none'
  /** Posed frames per epoch, lowest epoch first. */
  counts: Array<{ epoch: number; frames: number }>
  /** True when the posed frames span more than one epoch, so some of them are left out. */
  mixed: boolean
}

/**
 * Which epoch's poses to use for a session. A named `calibrationEpoch` wins even when it holds no frame: the
 * calibration says nothing about any other epoch, so choosing another would put its frames in the Place frame
 * through a transform that was never measured for them, and the fit that follows refuses for want of frames.
 */
export function chooseSessionEpoch(
  records: readonly KeyframeRecord[],
  calibrationEpoch?: number | null,
): SessionEpochChoice {
  const tally = new Map<number, number>()
  for (const record of records) {
    if (!recordHasPose(record)) continue
    const epoch = recordEpoch(record)
    tally.set(epoch, (tally.get(epoch) ?? 0) + 1)
  }
  const counts = [...tally.entries()].sort((a, b) => a[0] - b[0]).map(([epoch, frames]) => ({ epoch, frames }))
  const mixed = counts.length > 1
  if (typeof calibrationEpoch === 'number' && Number.isInteger(calibrationEpoch) && calibrationEpoch >= 0) {
    return { epoch: calibrationEpoch, source: 'calibration', counts, mixed }
  }
  if (counts.length === 0) return { epoch: null, source: 'none', counts, mixed }
  let best = counts[0]!
  for (const entry of counts) if (entry.frames > best.frames) best = entry
  return { epoch: best.epoch, source: 'majority', counts, mixed }
}

const IDENTITY_COLUMN_MAJOR: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/**
 * The AR camera centres of a session's frames in `epoch`, by frame key, in the SESSION frame: the frame and the
 * units the runtime recorded them in, with no calibration applied. This is the AR side of the per-session
 * similarity, whose other side is the solve's camera centres in the solver's frame (`sfmCentresFromPoses`).
 *
 * Reuses `metricCentresFromKeyframes` with the identity as the transform, which is what that function does for any
 * transform: the session-to-project matrix is applied by whoever has one.
 */
export function sessionCentres(
  records: readonly KeyframeRecord[],
  folder: string,
  epoch: number | null,
): Map<string, Vec3Tuple> {
  if (epoch === null) return new Map()
  const inEpoch = records.filter((record) => recordEpoch(record) === epoch)
  return metricCentresFromKeyframes(keyedRecords(inEpoch, folder), [...IDENTITY_COLUMN_MAJOR])
}

/** Where a session's frames are in the Place frame: the calibration, and the epoch it was made in. */
export interface SessionPlacement {
  /** Column-major 4x4, `ScanCalibration.sessionToProject`. */
  sessionToProject: readonly number[]
  /** The epoch the calibration is valid for, or null for none, which leaves every frame unposed. */
  epoch: number | null
}

/**
 * Why a placement cannot be used, in a sentence, or null when it can, or when there is none to check (no placement, or
 * no epoch, which leaves every frame unposed whatever the matrix is).
 *
 * `sessionToProject` is read as a column-major similarity: a rotation, one uniform scale, a translation in elements 12
 * to 14. Any 16 numbers would transform a camera centre without complaint, so a row-major matrix (the layout of
 * `SplatAlignManifest.projectTransform`, the other source of a placement) would put every frame in the wrong place and
 * say nothing. It is a similarity or it is refused. A row-major matrix with a translation has it in the elements that
 * must be 0 and is caught; one with no translation is a similarity read backwards, which nothing can tell from the real
 * thing, so the layout is stated wherever a placement is taken and is not guessed.
 */
export function placementProblem(placement: SessionPlacement | undefined): string | null {
  if (!placement || placement.epoch === null) return null
  if (sim3FromColumnMajor(placement.sessionToProject)) return null
  return 'its sessionToProject is not a column-major similarity (a rotation, one uniform scale and the translation in ' +
    'elements 12 to 14, with 0 0 0 1 as the last row of the 4x4); a row-major matrix such as the projectTransform of ' +
    'a splat-align manifest would move every frame to the wrong place without any error, so it is refused'
}

function normalised(v: Vec3Tuple): Vec3Tuple | null {
  const n = Math.hypot(v[0], v[1], v[2])
  return n > 0 && Number.isFinite(n) ? [v[0] / n, v[1] / n, v[2] / n] : null
}

/**
 * The records as pair-list images: a name, a session, a capture order, and, for a frame with a pose in the
 * placement's epoch, its camera centre and unit viewing direction in the Place frame.
 *
 * The camera of an AR runtime looks down its own -z (OpenGL), so the viewing direction is minus the third column of
 * the pose's rotation. The calibration is applied the way the editor applies it, column-major: the centre through
 * the whole matrix, the direction through its linear part and then normalised (a direction has no translation, and a
 * scale in the matrix must not lengthen it). Without a placement, with one that is not a similarity
 * ({@link placementProblem}), or for a frame with no pose or in another epoch, the image has no position: it keeps its
 * sequence neighbours and takes no part in the gates.
 */
export function pairImagesFromKeyframes(
  records: readonly KeyframeRecord[],
  folder: string,
  placement?: SessionPlacement,
): PairImage[] {
  const placed = placement && placement.epoch !== null && sim3FromColumnMajor(placement.sessionToProject)
    ? { matrix: [...placement.sessionToProject], epoch: placement.epoch }
    : null
  const images: PairImage[] = []
  let fallbackIndex = 0
  for (const record of records) {
    const file = record.file
    if (typeof file !== 'string' || file === '') continue
    const index = typeof record.index === 'number' && Number.isInteger(record.index) ? record.index : fallbackIndex
    fallbackIndex = index + 1
    const image: PairImage = { name: frameKey(folder, file), sessionId: folder, index }
    if (placed && recordHasPose(record) && recordEpoch(record) === placed.epoch) {
      const m = poseToMatrix(record.pose ?? {})
      const centre = applyColumnMajor(placed.matrix, [m[0]![3]!, m[1]![3]!, m[2]![3]!])
      const back: Vec3Tuple = [m[0]![2]!, m[1]![2]!, m[2]![2]!]
      const s = placed.matrix
      const forward = normalised([
        -(s[0]! * back[0] + s[4]! * back[1] + s[8]! * back[2]),
        -(s[1]! * back[0] + s[5]! * back[1] + s[9]! * back[2]),
        -(s[2]! * back[0] + s[6]! * back[1] + s[10]! * back[2]),
      ])
      if (forward && centre.every(Number.isFinite)) {
        image.position = centre
        image.forward = forward
      }
    }
    images.push(image)
  }
  return images
}
