/**
 * The pure half of a COLMAP solve over several sessions: what goes in each session's folder, and what COLMAP is told
 * about each session's camera.
 *
 * ## One camera per session
 *
 * `runColmapPoses` solves one session and tells `feature_extractor` that every image shares one camera
 * (`--ImageReader.single_camera 1`). That is right for one phone. A Place's sessions are not one phone: they are
 * different phones, different runtimes, different zoom and crop, and a single shared lens fitted to all of them is
 * wrong for every one. A joint solve therefore lays the frames out as `images/<sessionId>/kf-NNNNN.jpg` and gives each
 * folder its own camera (`--ImageReader.single_camera_per_folder`, present in COLMAP 3.13.0).
 *
 * A camera needs a starting point. COLMAP's own default is a focal length of 1.2 times the longer image side, which
 * is a guess. The keyframe records carry what the phone reported: a vertical field of view, `fovYDeg`, and the size of
 * the image it described. {@link deriveSessionCameraPrior} turns those into a focal length in the pixels of the JPEG
 * that was actually uploaded, with the principal point at the centre (the only place the records can put it), and
 * hands it to COLMAP as a prior. It is a prior and nothing more: the mapper refines the focal length from the images
 * (`Mapper.ba_refine_focal_length` is on by default), and the solved lens is what the poses file records.
 *
 * `--ImageReader.camera_params` applies to every camera one `feature_extractor` call creates, so each session is
 * extracted in a call of its own, listing its frames with `--image_list_path`, into the one database.
 *
 * ## What a camera cannot be
 *
 * All the images of one camera must have the same size: COLMAP refuses the run otherwise. A session whose frames come
 * in two sizes (a phone turned between portrait and landscape mid-walk) keeps the size most of its frames have, and
 * the rest are left out and reported, {@link planSessionFrames}.
 *
 * Pure: no Deno API, no file access.
 */
import { deriveIntrinsics, type KeyframeRecord } from '../splat/splat_train_dataset.ts'

/** One frame of a session, as it sits on disk. */
export interface JointFrame {
  /** `kf-00012.jpg`. */
  file: string
  /** Pixel size of the JPEG, from its header. */
  width: number
  height: number
}

export interface SkippedFrame {
  file: string
  reason: 'size-mismatch' | 'unreadable'
}

export interface PlannedSession {
  /** The size every kept frame has, which is the size of the session's camera. */
  width: number
  height: number
  /** The frames offered to COLMAP, in the order given. */
  kept: JointFrame[]
  /** Frames left out, with the reason. */
  skipped: SkippedFrame[]
}

/**
 * Pick the one size a session's camera will have: the size most of its frames have; on a tie the larger picture, then
 * the wider one, so the choice never depends on the order of the frames. Every frame of another size is skipped as
 * `'size-mismatch'`. Null for a session with no frames.
 */
export function planSessionFrames(frames: readonly JointFrame[]): PlannedSession | null {
  if (frames.length === 0) return null
  const tally = new Map<string, { width: number; height: number; count: number }>()
  for (const frame of frames) {
    const key = `${frame.width}x${frame.height}`
    const entry = tally.get(key)
    if (entry) entry.count++
    else tally.set(key, { width: frame.width, height: frame.height, count: 1 })
  }
  const sizes = [...tally.values()].sort((a, b) =>
    b.count - a.count || b.width * b.height - a.width * a.height || b.width - a.width
  )
  const chosen = sizes[0]!
  const kept: JointFrame[] = []
  const skipped: SkippedFrame[] = []
  for (const frame of frames) {
    if (frame.width === chosen.width && frame.height === chosen.height) kept.push(frame)
    else skipped.push({ file: frame.file, reason: 'size-mismatch' })
  }
  return { width: chosen.width, height: chosen.height, kept, skipped }
}

/** What COLMAP is told to start a session's camera from. */
export interface SessionCameraPrior {
  sessionId: string
  /** The size of the session's images, which is the size of its camera. */
  width: number
  height: number
  /**
   * `SIMPLE_RADIAL`'s four parameters, `[f, cx, cy, k]`, in pixels, or null when no keyframe reported a field of view
   * and COLMAP is left to its own default for this camera.
   */
  params: [number, number, number, number] | null
  /** `'keyframe-fov'`: from the field of view the keyframes reported. `'colmap-default'`: nothing was reported. */
  source: 'keyframe-fov' | 'colmap-default'
  /** How many keyframes the prior was made from: the ones that reported a plausible field of view or focal length. */
  fovFrames: number
  /**
   * The widest gap between two reported focal lengths, in pixels. Away from 0 it says the keyframes did not all
   * describe one lens (a runtime that reported its placeholder before the first real frame, or a zoom): the prior is
   * the median, which a few strays do not move.
   */
  focalSpreadPx: number
  /**
   * Keyframes that reported a field of view and were left out of the prior, and why. `placeholder`: every reporting
   * keyframe said exactly {@link PLACEHOLDER_FOV_Y_DEG} degrees, which is what a runtime reports before it has measured
   * a lens, so the session has no measurement at all. `implausible`: the reported lens is outside
   * {@link PLAUSIBLE_FOV_Y_DEG} at the size of the JPEG (a unit mistake, a corrupt value).
   */
  ignored: { placeholder: number; implausible: number }
}

/**
 * The vertical field of view, degrees, strictly inside which a reported lens is taken as a measurement. Outside it a
 * value is a bug, not a phone: the range `scripts/loop-pipeline-check.mjs` calls implausible for a keyframe's `fovYDeg`.
 *
 * **Adopted, not measured on a phone (ADR 0005 rule 5); measured on a rendered room.** COLMAP 3.13.0, three sessions, 42
 * frames: a prior of 50 times and of 0.02 times the true focal length (a field of view of 1 and of 175 degrees) made the
 * mapper exit 1, "failed to create sparse model", with no model; a prior of 0.2 times (133 degrees, inside this range) was
 * refitted to the true lens, 42 of 42 frames registered. With those first two left out as this does, the same sessions
 * register 42 of 42 on COLMAP's own default. So the range is inside what COLMAP survives and only keeps an absurd value
 * from ever reaching it. **Revisit when** a real phone reports a vertical field of view outside it.
 */
export const PLAUSIBLE_FOV_Y_DEG = { min: 20, max: 140 } as const

/**
 * What both AR providers report as the vertical field of view until their first real projection (`_fovY = 60` in
 * src/ar/eighthwall.ts and src/ar/webxr.ts). A real projection gives a value such as 64.58, so a session in which every
 * frame says exactly this never measured its lens: `scripts/loop-pipeline-check.mjs` calls that "the intrinsics probe is
 * not firing".
 */
export const PLACEHOLDER_FOV_Y_DEG = 60

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * The starting camera of one session, from its keyframe records.
 *
 * Only a record that reported a field of view (or a focal length) counts: `deriveIntrinsics` answers a made-up 55
 * degrees for a record that reported nothing, and a made-up number must not be dressed as a prior. Each reporting
 * record goes through `deriveIntrinsics` at the size of the JPEG that was uploaded, the same conversion the Brush dataset
 * builder uses, so the two cannot disagree about what `fovYDeg` means (ADR 0001). The prior is the median focal length
 * and the median principal point.
 *
 * Two screens keep a bad report from being passed as a measurement. A session in which every reporting frame says
 * exactly {@link PLACEHOLDER_FOV_Y_DEG} degrees reported a placeholder, not a lens, and gets no prior. A report that
 * implies a vertical field of view outside {@link PLAUSIBLE_FOV_Y_DEG} is a bug and is left out. Both are counted in
 * `ignored`. A few placeholder frames in a session of real ones are not screened: the median does not move for them,
 * and the spread says they were there.
 *
 * It can be off. Under the `cover` camera fit the field of view a phone reports describes the display, not the pixels
 * that were uploaded (the header of colmap_model.ts has the account). That is why it is only a prior: what the poses
 * file records is the lens COLMAP fitted.
 */
export function deriveSessionCameraPrior(
  sessionId: string,
  records: readonly KeyframeRecord[],
  size: { width: number; height: number },
): SessionCameraPrior {
  const reports: Array<{ derived: ReturnType<typeof deriveIntrinsics>; placeholder: boolean }> = []
  for (const record of records) {
    const reported = record.intrinsics
    if (!reported) continue
    const focalGiven = isPositive(reported.fx) || isPositive(reported.fy)
    if (!isPositive(reported.fovYDeg) && !focalGiven) continue
    reports.push({
      derived: deriveIntrinsics(reported, size.width, size.height),
      placeholder: !focalGiven && reported.fovYDeg === PLACEHOLDER_FOV_Y_DEG,
    })
  }
  const none = (ignored: SessionCameraPrior['ignored']): SessionCameraPrior => ({
    sessionId, ...size, params: null, source: 'colmap-default', fovFrames: 0, focalSpreadPx: 0, ignored,
  })
  if (reports.length > 0 && reports.every((report) => report.placeholder)) {
    return none({ placeholder: reports.length, implausible: 0 })
  }

  const focal: number[] = []
  const cx: number[] = []
  const cy: number[] = []
  let implausible = 0
  for (const { derived } of reports) {
    const impliedFovYDeg = (2 * Math.atan(size.height / (2 * derived.flY)) * 180) / Math.PI
    if (!(impliedFovYDeg > PLAUSIBLE_FOV_Y_DEG.min && impliedFovYDeg < PLAUSIBLE_FOV_Y_DEG.max)) {
      implausible++
      continue
    }
    focal.push(derived.flY)
    cx.push(derived.cx)
    cy.push(derived.cy)
  }
  if (focal.length === 0) return none({ placeholder: 0, implausible })
  return {
    sessionId,
    ...size,
    params: [median(focal), median(cx), median(cy), 0],
    source: 'keyframe-fov',
    fovFrames: focal.length,
    focalSpreadPx: Math.max(...focal) - Math.min(...focal),
    ignored: { placeholder: 0, implausible },
  }
}

/** The text of `--ImageReader.camera_params` for a prior: `f,cx,cy,k`, trimmed to what a pixel can mean. */
export function cameraParamsArg(prior: SessionCameraPrior): string | null {
  if (!prior.params) return null
  return prior.params.map((value) => String(Number(value.toFixed(4)))).join(',')
}

/**
 * The reader options of the `feature_extractor` call for one session of a joint solve: its own frames, one camera for
 * the folder, and the camera's prior when there is one.
 */
export function jointReaderArgs(imageListPath: string, prior: SessionCameraPrior): string[] {
  const params = cameraParamsArg(prior)
  return [
    '--image_list_path', imageListPath,
    '--ImageReader.single_camera_per_folder', '1',
    ...(params ? ['--ImageReader.camera_params', params] : []),
  ]
}

/** How many of a session's frames are in which model: the answer to "did this session join the solve". */
export interface SessionModelCounts {
  /** In the model the solve was read from. */
  registered: number
  /** In another model COLMAP built in the first pass and not in that one: a sub-model that did not merge. */
  inOtherModels: number
  /** In no model. */
  unregistered: number
}

/**
 * Where each session's frames ended up.
 *
 * `final` is the names registered in the model that was read; `firstPass` is the names registered in each model of
 * the first mapper pass. COLMAP does not merge a session it cannot tie to the others: it builds it as a model of its
 * own, so "joined" is "registered in the model that holds the most", and a session whose frames are all in
 * `inOtherModels` did not join. Names are the image names, `<sessionId>/kf-NNNNN.jpg`.
 */
export function countSessionModels(
  offered: ReadonlyMap<string, readonly string[]>,
  final: ReadonlySet<string>,
  firstPass: ReadonlyArray<ReadonlySet<string>>,
): Map<string, SessionModelCounts> {
  const out = new Map<string, SessionModelCounts>()
  for (const [sessionId, names] of offered) {
    let registered = 0
    let inOtherModels = 0
    for (const name of names) {
      if (final.has(name)) registered++
      else if (firstPass.some((model) => model.has(name))) inOtherModels++
    }
    out.set(sessionId, { registered, inOtherModels, unregistered: names.length - registered - inOtherModels })
  }
  return out
}
