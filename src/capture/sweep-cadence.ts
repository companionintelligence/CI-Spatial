/**
 * When to take a photo during a tripod sweep, and when to refuse to.
 *
 * ## Why this is a cadence and not a button
 *
 * Tripod Scan's whole shape is: set the tripod down, START THE SWEEP, AND WALK
 * OUT OF SHOT. The gimbal then steps through six to twelve positions, dwelling
 * roughly 0.8-1.5 s at each one so the picture settles. There is nobody in the
 * room to tap anything — "step out of the way" is the instruction the sheet
 * gives one screen earlier — so a per-position tap would either put the
 * operator back in every frame or leave the sweep uncaptured. The tap is the
 * one thing this design cannot use.
 *
 * The obvious alternative — ask the gimbal where it is — is not available and
 * must not be built. The gimbal runs as a separate process on the host; the
 * phone reaches the host over Tailscale but not its localhost, and coupling a
 * browser capture to a host-side driver would make the camera path fail
 * whenever the driver is not running. So the page samples on its own clock.
 *
 * ## Why 700 ms
 *
 * {@link SWEEP_SAMPLE_MS} is deliberately SHORTER than {@link GIMBAL_MIN_DWELL_MS}.
 * Sampling every 700 ms means every 800 ms window of time contains at least one
 * sample instant, so every dwell — however the page's clock happens to line up
 * with the gimbal's — is photographed at least once. The price is the two or so
 * samples that land mid-move and come out smeared; those are the frames the
 * server's ingest already drops (`server/main.ts` — "the script re-orders by
 * EXIF capture time and drops blurry frames"), and dropping them here as well
 * would risk emptying a spot the operator watched succeed. Filtering stays
 * where it is measured.
 *
 * A twelve-position sweep at ~2.5 s per position therefore banks around 43
 * photos, against the 36 that reconstructed a room at 36-of-36 usable.
 *
 * ## The one thing this module refuses
 *
 * A `<video>` fed by a stopped camera keeps reporting `readyState >= 2`
 * forever, and drawing it produces the same frozen picture again and again —
 * `src/ar/webxr.ts` was re-encoding exactly that corpse before it started
 * watching `currentTime`. Here that failure would be worse than a blank
 * screen: forty identical photos is a spot that LOOKS captured, climbs the
 * tally, and reconstructs nothing. So a frame is only banked while
 * `currentTime` is still moving, and a feed frozen past
 * {@link SWEEP_STALL_MS} ends the sweep with a reason instead of filling it.
 *
 * Pure, and separate from `sweep-camera.ts`, for the reason `station-capture.ts`
 * is separate from the sheet: the decisions worth testing here are refusals and
 * timing, and neither needs a camera.
 */

/**
 * How often the page grabs a frame while a sweep runs.
 *
 * Shorter than the shortest dwell on purpose — see the module note. Changing
 * this above {@link GIMBAL_MIN_DWELL_MS} breaks the guarantee that every gimbal
 * position is photographed.
 */
export const SWEEP_SAMPLE_MS = 700

/**
 * The shortest dwell the gimbal is configured to hold at a position.
 *
 * Stated here as the number {@link SWEEP_SAMPLE_MS} is chosen against, not as a
 * value anything reads from the gimbal: this module never talks to it.
 */
export const GIMBAL_MIN_DWELL_MS = 800

/** How long the picture may sit frozen before the sweep is called off. */
export const SWEEP_STALL_MS = 1500

/**
 * Most photos one sweep will bank.
 *
 * A ceiling on an unattended loop, not a target. Twelve positions at ~2.5 s
 * each samples about 43 times, so this sits just above a full slow sweep; past
 * it, the sweep has stopped being a sweep and is photographing a room nobody is
 * turning the camera in.
 */
export const SWEEP_MAX_FRAMES = 48

/** And the same ceiling in time, for a sweep whose camera went quiet. */
export const SWEEP_MAX_MS = 90_000

/**
 * Longest edge of a banked photo, in pixels.
 *
 * 1920 is what the reconstruction has been fed all along. The short edge falls
 * out of the camera's own aspect ratio — a frame is never stretched to a shape
 * the lens did not see, because that is a lie about the room's geometry that
 * nothing downstream can detect.
 */
export const FRAME_LONG_EDGE = 1920

/** JPEG quality for a banked frame. */
export const FRAME_QUALITY = 0.86

/** Why a sweep's capture stopped. */
export type SweepEndReason =
  /** The operator marked the sweep finished, or closed the sheet. */
  | 'stopped'
  /** The picture stopped moving — see the module note. */
  | 'stalled'
  /** {@link SWEEP_MAX_FRAMES} reached. */
  | 'full'
  /** {@link SWEEP_MAX_MS} reached. */
  | 'timeout'

export interface CadenceState {
  readonly startedAtMs: number
  /** Photos actually banked. Only {@link noteCaptured} moves it. */
  readonly captured: number
  /** When a frame was last ASKED for, so a failing encode cannot spin. */
  readonly lastAttemptMs: number | null
  /** Last `video.currentTime` seen, the liveness signal. */
  readonly lastCurrentTime: number
  /**
   * The picture has been SEEN to move — two different readings, not one.
   *
   * The first reading of a feed cannot tell a camera that has just started
   * from one that stopped a minute ago: both offer a number, and both offer a
   * frame. Without this, a camera that was already dead banked exactly one
   * photo of whatever it had last managed, and a spot with one stale frame in
   * it is a spot that reads as captured. So nothing is banked until the
   * picture has been watched to change at least once.
   */
  readonly seenLive: boolean
  /** When `currentTime` was first seen frozen, or null while it is moving. */
  readonly stalledSinceMs: number | null
  readonly ended: SweepEndReason | null
}

/** What the page saw of the camera this tick. */
export interface CameraTick {
  nowMs: number
  /** `video.readyState`. Below 2 there is nothing to draw. */
  readyState: number
  videoWidth: number
  /** `video.currentTime` — only moves while the camera is delivering. */
  currentTime: number
  /**
   * The page is backgrounded.
   *
   * Android stops the feed when Chrome goes to the background, which is a
   * frozen `currentTime` that is not a broken camera. Treating it as a stall
   * would end a sweep because a notification was pulled down, so a hidden page
   * banks nothing, ends nothing, and resets the stall baseline on the way back.
   */
  hidden?: boolean
}

export type CadenceAction =
  /** Nothing to do this tick. */
  | 'wait'
  /** Draw and bank a frame now. */
  | 'capture'
  /** The sweep is over; `state.ended` says why. */
  | 'end'

export function startCadence(nowMs: number): CadenceState {
  return {
    startedAtMs: nowMs,
    captured: 0,
    lastAttemptMs: null,
    lastCurrentTime: -1,
    seenLive: false,
    stalledSinceMs: null,
    ended: null,
  }
}

/** Stop the cadence for a reason the caller knows — the operator, usually. */
export function endCadence(state: CadenceState, reason: SweepEndReason): CadenceState {
  if (state.ended) return state
  return { ...state, ended: reason }
}

/** A frame was drawn, encoded and banked. The only thing that moves the tally. */
export function noteCaptured(state: CadenceState): CadenceState {
  return { ...state, captured: state.captured + 1 }
}

/**
 * One turn of the capture loop.
 *
 * Order matters: the ceilings are checked before liveness so a sweep that has
 * banked its fill ends as 'full' rather than being reported as a broken camera,
 * and liveness is checked before the cadence so a frozen picture is never the
 * thing that gets banked.
 */
export function tickCadence(state: CadenceState, tick: CameraTick): { state: CadenceState, action: CadenceAction } {
  if (state.ended) return { state, action: 'end' }

  if (state.captured >= SWEEP_MAX_FRAMES) {
    return { state: endCadence(state, 'full'), action: 'end' }
  }
  if (tick.nowMs - state.startedAtMs >= SWEEP_MAX_MS) {
    return { state: endCadence(state, 'timeout'), action: 'end' }
  }

  // Backgrounded: not a fault, and not a frame either. The baseline is cleared
  // so the first tick back does not read the whole background as a freeze.
  if (tick.hidden) {
    // Liveness has to be re-earned on the way back for the same reason it had
    // to be earned at the start: the first reading after a background is
    // indistinguishable from a camera that never came back.
    return { state: { ...state, stalledSinceMs: null, lastCurrentTime: -1, seenLive: false }, action: 'wait' }
  }

  // Nothing decodable yet — a camera still warming up. Not a stall: the stall
  // clock is about a feed that HAD frames and stopped, and `SWEEP_MAX_MS` is
  // what catches a camera that never arrives at all.
  if (tick.readyState < 2 || tick.videoWidth === 0) {
    return { state, action: 'wait' }
  }

  let next: CadenceState
  if (tick.currentTime !== state.lastCurrentTime) {
    // A first reading is a baseline, not proof of life; the second different
    // one is. `lastCurrentTime` starts at -1, which no real currentTime is.
    const seenLive = state.seenLive || state.lastCurrentTime >= 0
    next = { ...state, lastCurrentTime: tick.currentTime, seenLive, stalledSinceMs: null }
  } else if (state.stalledSinceMs === null) {
    next = { ...state, stalledSinceMs: tick.nowMs }
  } else if (tick.nowMs - state.stalledSinceMs >= SWEEP_STALL_MS) {
    return { state: endCadence(state, 'stalled'), action: 'end' }
  } else {
    next = state
  }

  // Frozen, but not yet long enough to call it off. Bank nothing meanwhile —
  // the frame on offer is the same one already banked. Nor before the picture
  // has been watched to move at all.
  if (next.stalledSinceMs !== null || !next.seenLive) return { state: next, action: 'wait' }

  const due = next.lastAttemptMs === null || tick.nowMs - next.lastAttemptMs >= SWEEP_SAMPLE_MS
  if (!due) return { state: next, action: 'wait' }

  return { state: { ...next, lastAttemptMs: tick.nowMs }, action: 'capture' }
}

/**
 * The frame's pixel size: the camera's own aspect, longest edge capped.
 *
 * A camera that already hands over something smaller is left alone — upscaling
 * invents detail the reconstruction would then trust.
 */
export function frameSize(videoWidth: number, videoHeight: number): { width: number, height: number } | null {
  if (!Number.isFinite(videoWidth) || !Number.isFinite(videoHeight)) return null
  if (videoWidth < 1 || videoHeight < 1) return null
  const long = Math.max(videoWidth, videoHeight)
  if (long <= FRAME_LONG_EDGE) {
    return { width: Math.round(videoWidth), height: Math.round(videoHeight) }
  }
  const scale = FRAME_LONG_EDGE / long
  return {
    width: Math.max(1, Math.round(videoWidth * scale)),
    height: Math.max(1, Math.round(videoHeight * scale)),
  }
}

/**
 * The file name a banked frame carries.
 *
 * The server prefixes every uploaded photo with its upload index before the
 * ingest script sees it (`server/main.ts` — "The index prefix keeps upload
 * order stable for photos without EXIF"), and a canvas JPEG has no EXIF, so
 * order is already safe. This is padded anyway so a directory of them reads in
 * the order they were taken, and carries the spot so a set of files pulled off
 * a phone by hand still says where each one came from.
 *
 * `spot` is 1-based, as the operator counts.
 */
export function frameFileName(spot: number, index: number): string {
  return `sweep-spot${String(spot).padStart(2, '0')}-${String(index).padStart(4, '0')}.jpg`
}

/**
 * The tally under the preview, while the camera is running.
 *
 * Present tense and a bare count: this line's entire job is to be checkable
 * against reality by someone glancing at a phone across a room, so it says the
 * number of photos that exist and nothing about what they are worth.
 */
export function sweepCountLine(captured: number): string {
  if (captured === 0) return 'No photos yet — the camera is watching.'
  return `${captured} photo${captured === 1 ? '' : 's'} taken from this spot.`
}

/**
 * What to say when the camera stops on its own.
 *
 * 'stopped' has no line: the operator pressed the button, and a screen that
 * announces what the person just did is noise. The other three are things that
 * happened TO the sweep, and each names what to do next, because each leaves
 * the photos already banked perfectly usable.
 */
export function sweepEndNotice(reason: SweepEndReason, captured: number): string | null {
  const have = `${captured} photo${captured === 1 ? '' : 's'}`
  switch (reason) {
    case 'stopped':
      return null
    case 'stalled':
      return `The camera stopped sending pictures, so this spot has ${have} and no more. `
        + `Press ${CAMERA_ON_LABEL} to try again, or mark the sweep finished and keep what it took.`
    case 'full':
      return `That is ${have} from this spot — enough from one place. Mark the sweep finished and move the tripod.`
    case 'timeout':
      return `The sweep has been running a while, so the camera has stopped with ${have}. `
        + 'Mark the sweep finished if the tripod has been all the way round.'
  }
}

/**
 * The button that opens the camera for the spot being swept.
 *
 * It exists because a sweep and its camera can come apart: the sheet can be
 * closed part-way through and re-opened, and a camera refused the first time
 * can be allowed and tried again. Without it, "allow the camera and try again"
 * would mean throwing away the spot in progress to get back to a button.
 */
export const CAMERA_ON_LABEL = 'Photograph this sweep'

/**
 * Why the camera could not open, and what still works.
 *
 * Every one of these leaves the import button in place, which is the point: a
 * phone that will not open its camera to this page can still finish a capture
 * taken some other way, and someone recovering a half-finished capture goes
 * through the same door.
 */
export function cameraRefusal(cause: 'unsupported' | 'denied' | 'busy' | 'failed'): string {
  const fallback = 'Photos taken another way can still be added below.'
  switch (cause) {
    case 'unsupported':
      return `This browser will not give the page a camera. ${fallback}`
    case 'denied':
      return `Camera access was refused, so the sweep cannot photograph anything. `
        + `Allow the camera for this site, then press ${CAMERA_ON_LABEL}. ${fallback}`
    case 'busy':
      return `Something else on the phone is holding the camera. Close it, or reload this page, `
        + `then press ${CAMERA_ON_LABEL}. ${fallback}`
    case 'failed':
      return `The camera would not open. ${fallback}`
  }
}
