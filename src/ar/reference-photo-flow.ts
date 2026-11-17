/**
 * Reference photos inside the calibration flow: when each is taken, where its crosshair goes, and what happens when one
 * cannot be taken (WP-07). The shapes and the arithmetic are ./reference-photo.ts; this is the state around them, and the
 * calibration modal (./project-calibration.ts) holds a few lines of it.
 *
 * Pure of the DOM and of any AR runtime (ADR 0002: the browser imports this file): the host says how to take a frame, how
 * big the view is, what lens it has and where the camera is, and a test says the same with numbers.
 *
 * ## Three ways the photos were lost or wrong
 *
 * 1. **The crosshair followed the tap, and the phone moved.** A marker's crosshair was the normalised tap that placed it.
 *    The photo is taken later: at the earliest when the camera answers the request made at the tap, and at the Commit for a
 *    point that has to be taken again. A phone that has moved in between has its picture moved with it, so the tap pointed
 *    at another place in the photo than the one it was made at.
 * 2. **A moved landmark lost its photo.** Moving the landmark after Confirm dropped its photo and nothing took another.
 *    The commit then had one photo, a frame keeps both or none (src/project/frame-sync.ts), and the Place was saved with
 *    no photos at all, with a line in the console.
 * 3. **A photo that does not show the marker was kept, or dropped, without a word.**
 *
 * ## Where the crosshair goes
 *
 * There are two honest ways to find a marker in a picture. The tap that placed it is exact for the picture the phone was
 * looking at when the finger landed, so while the phone has not moved since the tap (`posesAreStill`, the resolver's rule
 * of 2 cm and 2 degrees) the tap's own pixel is the answer and no lens has to be right. Once the phone has moved, the
 * marker's position projected through the pose the photo was taken at is the answer (`projectMarkerIntoPhoto`), which is
 * right wherever the phone went, as far as the lens the provider reports is right. A marker that falls outside that
 * picture is not shown by it, and the photo is not kept as one that does.
 *
 * A runtime that cannot say its lens (the native provider's field of view is NaN, and a stand-in may have none) has
 * nothing to project through, so its crosshair is the tap, as it was before this file existed.
 *
 * ## When it is taken, and when it is taken again
 *
 * Each marker at its own tap, while the person is looking at the spot they just tapped (the modal decides which taps ask:
 * `applyTap` and the Confirm button in ./project-calibration.ts): the landmark at Confirm, and again each time it is moved
 * after that; the heading marker and the check point at their taps, on a visit that writes the Place's frame. A visit to a
 * stored pair takes the markers it keeps only when "Use anyway" keeps them, at the commit and after the mismatch check, so
 * that a pair that is sent back for re-placement costs no frame. Labels typed later are put on the photos when the commit
 * collects them, not when they are taken.
 *
 * **One frame at a time.** A provider takes a single camera frame and refuses a request made while one is pending
 * ("Capture already pending"), and a person taps the next marker, or presses Commit, while the last frame is still on its
 * way. So a request waits for the one before it, however fast the taps come: `begin` and the second try in `settle` go
 * through one line of requests, each asked for when the one before it is answered, whatever that answer was. When nothing is
 * pending the host is asked at once.
 *
 * At Commit every point must have a photo that shows it: one that was taken and is still good is kept (a person who aims
 * the phone at Point A after being told Point B was out of view does not lose Point B's photo), and one that is missing is
 * taken again, then, once the frames already asked for have arrived. If a point still has none, the commit holds once and
 * says which, and the next press saves the alignment without photos: the photo is an aid, never a gate. A host that cannot
 * take photos at all is not a failure to report; nothing is held for it.
 */
import { posesAreStill } from '../spatial/resolver.ts'
import type { Vec3 } from '../world/types.ts'
import {
  projectMarkerIntoPhoto,
  tapPointWithinPhoto,
  type PendingReferencePhoto,
  type PhotoSize,
  type ReferencePhotoCapture,
  type ReferencePhotoRole,
} from './reference-photo.ts'
import { photoHoldText, type PhotoProblem } from './return-visit-copy.ts'

/** A camera pose, as the provider and a photo's record state it. */
export type CameraPose = ReferencePhotoCapture['pose']

/** Where a tap landed on the canvas, normalised to 0 to 1. */
export interface TapPoint {
  x: number
  y: number
}

/** The lens the view is drawn with: the vertical field of view in degrees, and the view's width over its height. */
export interface PhotoLens {
  fovYDeg: number
  aspect: number
}

/** What the flow needs of its surroundings. */
export interface ReferencePhotoHost {
  /** Takes the next camera frame. Absent when the host cannot: then no photo is attempted and none is missed. May resolve null or reject. */
  capturePhoto?: () => Promise<ReferencePhotoCapture | null>
  /** The canvas the person taps on, in pixels. */
  view: () => PhotoSize
  /** The lens the view is drawn with, or null when the runtime cannot say. */
  lens: () => PhotoLens | null
  /** Where the camera is now, or null. Read only while a lens is known, because a pose is only used to tell whether the phone has moved. */
  pose: () => CameraPose | null
  /** The time a photo is stamped with, an ISO string. Default: now. */
  now?: () => string
}

/** One attempt at a photo: it showed the marker, or it did not, or there was nothing to take. */
type ShotOutcome =
  | { kind: 'taken'; photo: PendingReferencePhoto }
  /** A frame came back and the marker is not in it. */
  | { kind: 'out-of-view' }
  /** No usable frame: the capture refused or timed out, or the frame cannot be mapped to the view. */
  | { kind: 'failed' }
  /** The host has no frame to give. Not a failure to report. */
  | { kind: 'unavailable' }

/** What `begin` knows about a task it started, kept beside the promise it returned. */
interface ShotRecord {
  marker: Vec3
  outcome: ShotOutcome | null
}

/** A point the commit needs a photo of: the one a task was started for, if any, and where the marker is now. */
export interface PhotoWanted {
  role: ReferencePhotoRole
  /** The task `begin` returned for this marker, or null when none was started or it was dropped. */
  task: Promise<PendingReferencePhoto | null> | null
  marker: Vec3 | null
  tap: TapPoint | null
}

export interface ReferencePhotoFlow {
  /**
   * A touch on the canvas, read before its hit test is answered: returns the tap point to carry through placement, and
   * remembers where the camera was at that moment so a photo taken later can tell whether the phone has moved since.
   */
  touch(x: number, y: number): TapPoint
  /**
   * Starts a photo of a marker. The promise never rejects: it resolves to the photo, or to null when the photo could not
   * be made to show the marker. Returns null when there is nothing to start (the host takes no photos, or there is no
   * marker). `existing` is the task a marker already has: it is returned as it is while it is for this same marker and is
   * pending or good, so that a good photo is not thrown away by asking again.
   */
  begin(
    role: ReferencePhotoRole,
    marker: Vec3 | null,
    tap: TapPoint | null,
    existing?: Promise<PendingReferencePhoto | null> | null,
  ): Promise<PendingReferencePhoto | null> | null
  /** The photo a point has: its task's, if that is good, and otherwise one taken now. Null when there is none. */
  settle(wanted: PhotoWanted): Promise<PendingReferencePhoto | null>
  /**
   * What stands between the commit and a frame saved with every photo, after the points were settled: the sentence to show
   * and stop on, or null to go on. A situation that has been shown once is not shown again: the press after it goes on.
   * `button` is the name the card gives the button the person pressed, which the sentence tells them to press again
   * (`photoHoldText`): the commit is pressed as "Use this alignment" in review and as "Use anyway" on the mismatch screen.
   */
  holdText(button?: string | null): string | null
}

const sameMarker = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z

/** The pose as plain numbers, so a provider that reuses one object for every frame cannot move it under the flow. */
function copyPose(pose: CameraPose): CameraPose {
  const { position: p, rotation: q } = pose
  return { position: { x: p.x, y: p.y, z: p.z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } }
}

/**
 * The lens a provider reports, or null when it cannot say: a method it lacks, a field of view that is not a lens (the
 * native provider's is NaN) or an aspect that is not above 0. The two methods are the ones `src/main.ts` builds its
 * capture camera from.
 */
export function lensOfProvider(provider: { getCameraFovY?: () => number; getCameraAspect?: () => number }): PhotoLens | null {
  const fovYDeg = provider.getCameraFovY?.()
  const aspect = provider.getCameraAspect?.()
  if (typeof fovYDeg !== 'number' || typeof aspect !== 'number') return null
  if (!Number.isFinite(fovYDeg) || !Number.isFinite(aspect)) return null
  return fovYDeg > 0 && fovYDeg < 180 && aspect > 0 ? { fovYDeg, aspect } : null
}

export function createReferencePhotoFlow(host: ReferencePhotoHost): ReferencePhotoFlow {
  /** Where the camera was when each tap landed, by the tap object `touch` handed out. */
  const tapPoses = new WeakMap<TapPoint, CameraPose>()
  const records = new WeakMap<Promise<PendingReferencePhoto | null>, ShotRecord>()
  /**
   * The answer to the request made last, while one is outstanding, or null. A provider takes one frame at a time and refuses a
   * second request while the first is pending ("Capture already pending"), so a request is made when this is answered and not
   * before (`inTurn`). Each request chains on the one before it, so any number made in a row are asked for one after the other.
   */
  let lane: Promise<unknown> | null = null
  /** What each point's photo came to in the settle that is under way, for `holdText`. */
  const round = new Map<ReferencePhotoRole, { outcome: ShotOutcome; marker: Vec3 | null }>()
  /** The situation the person was last held for, so the press after it goes on. */
  let told: string | null = null

  function readPose(): CameraPose | null {
    try {
      const pose = host.pose()
      return pose ? copyPose(pose) : null
    } catch {
      return null
    }
  }

  /** One attempt: the next frame, and where the marker is in it. Never rejects. */
  async function takeShot(role: ReferencePhotoRole, marker: Vec3, tap: TapPoint | null): Promise<ShotOutcome> {
    const capture = host.capturePhoto
    if (!capture) return { kind: 'unavailable' }
    let frame: ReferencePhotoCapture | null
    try {
      frame = await capture()
    } catch {
      // "Capture already pending", a denied frame, a timeout: a failed photo, never a failed calibration.
      return { kind: 'failed' }
    }
    if (!frame) return { kind: 'unavailable' }
    try {
      const view = host.view()
      const lens = host.lens()
      const tapPose = tap ? tapPoses.get(tap) : undefined
      let within: TapPoint | null
      if (lens === null || (tapPose !== undefined && posesAreStill(tapPose, frame.pose))) {
        // The tap is where the marker is in this picture: the phone has not moved since it, or the runtime has no lens
        // to project through and the tap is all there is.
        within = tap ? tapPointWithinPhoto(tap, frame.frameSize, view) : null
      } else {
        const inView = projectMarkerIntoPhoto(marker, frame.pose, lens.fovYDeg, lens.aspect)
        if (!inView) return { kind: 'out-of-view' }
        within = tapPointWithinPhoto({ x: inView.u, y: inView.v }, frame.frameSize, view)
      }
      if (!within) return { kind: 'failed' }
      return {
        kind: 'taken',
        photo: {
          role,
          blob: frame.blob,
          thumbDataUrl: frame.thumbDataUrl,
          tapPoint: within,
          pose: frame.pose,
          capturedAt: host.now ? host.now() : new Date().toISOString(),
          label: null,
        },
      }
    } catch {
      return { kind: 'failed' }
    }
  }

  /**
   * Makes a request in its turn: at once when none is outstanding, otherwise when the one made before it is answered, whether it
   * was a photo or a failure. The shots never reject, so the line cannot be broken by one.
   */
  function inTurn<T>(request: () => Promise<T>): Promise<T> {
    const turn = lane ? lane.then(request) : request()
    const answered: Promise<unknown> = turn.then(() => undefined, () => undefined)
    lane = answered
    void answered.then(() => {
      if (lane === answered) lane = null
    })
    return turn
  }

  function touch(x: number, y: number): TapPoint {
    const tap = { x, y }
    if (host.lens() !== null) {
      const pose = readPose()
      if (pose) tapPoses.set(tap, pose)
    }
    return tap
  }

  function begin(
    role: ReferencePhotoRole,
    marker: Vec3 | null,
    tap: TapPoint | null,
    existing?: Promise<PendingReferencePhoto | null> | null,
  ): Promise<PendingReferencePhoto | null> | null {
    if (!host.capturePhoto || !marker) return null
    const kept = existing ? records.get(existing) : undefined
    if (existing && kept && sameMarker(kept.marker, marker) && (kept.outcome === null || kept.outcome.kind === 'taken')) return existing
    const record: ShotRecord = { marker: { x: marker.x, y: marker.y, z: marker.z }, outcome: null }
    const task = inTurn(() => takeShot(role, record.marker, tap)).then((outcome) => {
      record.outcome = outcome
      return outcome.kind === 'taken' ? outcome.photo : null
    })
    records.set(task, record)
    return task
  }

  async function settle(wanted: PhotoWanted): Promise<PendingReferencePhoto | null> {
    const { role, task, marker, tap } = wanted
    const earlier = task ? await task.catch(() => null) : null
    if (earlier) {
      round.set(role, { outcome: { kind: 'taken', photo: earlier }, marker })
      return earlier
    }
    // Nothing good from before. A host that had no frame to give for the first try has none now either.
    const first = task ? records.get(task)?.outcome : undefined
    if (!host.capturePhoto || !marker || first?.kind === 'unavailable') {
      round.set(role, { outcome: { kind: 'unavailable' }, marker })
      return null
    }
    // The frames already asked for arrive first: this one is in line behind them.
    const outcome = await inTurn(() => takeShot(role, marker, tap))
    round.set(role, { outcome, marker })
    return outcome.kind === 'taken' ? outcome.photo : null
  }

  function holdText(button?: string | null): string | null {
    const settled = [...round]
    round.clear()
    const problems: Array<PhotoProblem & { marker: Vec3 | null }> = []
    for (const [role, { outcome, marker }] of settled) {
      if (outcome.kind === 'out-of-view' || outcome.kind === 'failed') problems.push({ role, kind: outcome.kind, marker })
    }
    if (problems.length === 0) {
      told = null
      return null
    }
    const situation = problems
      .map(({ role, kind, marker }) => `${role}:${kind}@${marker ? `${marker.x},${marker.y},${marker.z}` : '-'}`)
      .sort()
      .join('|')
    if (told === situation) {
      told = null
      return null
    }
    told = situation
    return photoHoldText(problems, button)
  }

  return { touch, begin, settle, holdText }
}
