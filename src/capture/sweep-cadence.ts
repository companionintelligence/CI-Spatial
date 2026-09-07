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
 * ## Why the clock alone is not the cadence
 *
 * The first version of this module sampled every 700 ms and stopped at 48
 * frames. Measured on a real gimbal on 2026-08-29 that is 33.6 s of capture
 * against a ten-position sweep that ran 60-90 s: a spot's photos covered
 * roughly the first half of the arc and the far end of the room was never
 * photographed at all. The cadence and the ceiling had been tuned against each
 * other rather than against a sweep.
 *
 * The knob that was wrong is neither of them on their own — it is that the
 * page was spending its frame budget at a fixed rate on a sweep whose length
 * it does not know. So banking is paced by the PICTURE instead:
 *
 *   - the view is settled and shows something the last banked photo did not
 *     — the gimbal has arrived somewhere new and the picture has stopped
 *     smearing, which is the one moment worth a photograph. One per position.
 *   - or {@link SWEEP_FORCE_BANK_MS} has gone by without a photo. The floor,
 *     and the reason a wrong threshold cannot empty a spot: at worst this
 *     degrades to a photo every four seconds, spread across the whole window,
 *     which is still the whole arc where 700 ms x 48 was the first half of it.
 *
 * A sweep of 60-90 s therefore banks roughly one sharp frame per position plus
 * the floor's, about 25-40 photos spread end to end — against the 36 that
 * reconstructed a room at 36-of-36 usable, and the 9 of 12 that solved one with
 * 372 points. More frames of one wall was never the thing that was missing.
 *
 * {@link SWEEP_SAMPLE_MS} survives as the MINIMUM gap between two photos, and
 * as the whole cadence on a page that cannot measure the picture at all (a
 * canvas that will not give up its pixels): there, `motion`/`novelty` arrive
 * null and this falls back to the plain 700 ms clock, which is shorter than
 * {@link GIMBAL_MIN_DWELL_MS} so every dwell still contains a sample instant.
 *
 * ## Saying so when the view stops moving
 *
 * The operator has stepped out of the room. A gimbal that jams at position 4
 * leaves the camera running, the frames arriving and the tally climbing — 48
 * photos of one wall, and a screen that said only "48 photos". The same signal
 * that paces the banking knows this: if nothing has moved for
 * {@link SWEEP_STILL_WARN_MS}, {@link sweepMotionNotice} says so while the
 * sweep is still recoverable.
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
 * The shortest gap allowed between two banked photos.
 *
 * Also the entire cadence when the picture cannot be measured — see the module
 * note — which is why it stays below {@link GIMBAL_MIN_DWELL_MS}: on that
 * fallback path every 800 ms dwell still contains a sample instant whatever the
 * phase between the two clocks. Raising it above that dwell would break the
 * only guarantee the fallback has.
 */
export const SWEEP_SAMPLE_MS = 700

/**
 * Longest the sweep will go without banking anything, once the camera is live.
 *
 * The floor under the picture-led cadence, and the reason a badly chosen
 * {@link VIEW_SETTLED} or {@link VIEW_NEW} cannot produce an empty spot: with
 * both gates permanently shut this is still a photo every four seconds for the
 * length of the sweep. Four rather than one because a frame taken mid-move is
 * smeared and gets dropped at the far end anyway; this is coverage insurance,
 * not the plan.
 */
export const SWEEP_FORCE_BANK_MS = 4_000

/**
 * How different two looks at the picture may be and still count as "not
 * moving", as a mean absolute difference over a small grid of the frame, 0-1.
 *
 * Chosen, not measured — no gimbal was on the desk when this was written. It is
 * safe to be wrong in either direction: too low and the gate simply never
 * fires, leaving {@link SWEEP_FORCE_BANK_MS}; too high and a moving picture
 * reads as settled, which banks a smeared frame that is dropped downstream.
 * Neither can empty a spot, and neither can overrun a ceiling.
 */
export const VIEW_SETTLED = 0.015

/**
 * How different the settled picture must be from the last banked photo before
 * it is worth another one. Same units, same "chosen, not measured" caveat.
 */
export const VIEW_NEW = 0.04

/**
 * How long the view may sit unchanged before the sheet says so.
 *
 * Longer than any dwell, and far shorter than a sweep: a jam at position 4 is
 * worth interrupting a stepped-out operator for, a 1.5 s pause is not.
 */
export const SWEEP_STILL_WARN_MS = 20_000

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
 * Still a ceiling on an unattended loop, and still not a target — past it, the
 * sweep has stopped being a sweep and is photographing a room nobody is turning
 * the camera in. Sized above what a legitimate full sweep can reach rather than
 * beside it: {@link SWEEP_MAX_MS} of the floor alone is 37 photos, plus one per
 * position for a sweep of up to twenty. It was 48, which a 90 s sweep hit at
 * the 33 s mark and stopped photographing the room.
 */
export const SWEEP_MAX_FRAMES = 64

/**
 * And the same ceiling in time, for a sweep whose camera went quiet.
 *
 * It was 90 s, which is the length of the longest sweep measured — a ceiling
 * exactly at the size of the thing it is meant to be above. 150 s clears a slow
 * ten-position arc with room to spare and still ends a camera nobody came back
 * to.
 */
export const SWEEP_MAX_MS = 150_000

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
  /**
   * When the VIEW — what the camera is pointed at — was last seen to change.
   *
   * A different thing from `stalledSinceMs`, and the distinction is the whole
   * of defect 3 on the 2026-08-29 run: a jammed gimbal delivers a perfectly
   * healthy feed of a perfectly stationary wall. `currentTime` keeps moving,
   * so the stall guard is right to say nothing; this is what notices.
   *
   * Null until the picture has been measured at all, which is also what
   * {@link viewStillMs} reports as "not still" — an unmeasured picture must
   * never be accused of having stopped.
   */
  readonly lastMovedAtMs: number | null
  /**
   * The view has moved since the last photo was banked.
   *
   * What holds the settled-and-new gate to ONE photo per gimbal position: the
   * picture has to leave before it can arrive somewhere worth photographing
   * again. Without it a long dwell would bank a photo every 700 ms of the same
   * settled view, which is the frozen-feed failure with extra steps.
   */
  readonly movedSinceBank: boolean
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
  /**
   * How much the picture changed since the previous look, 0-1, or null when
   * the page could not measure it (no pixels came back from the canvas, or
   * this is the first look and there is nothing to compare against).
   *
   * A number, not a decision, so the thresholds stay in this module with the
   * reasoning next to them and `sweep-camera.ts` keeps only the arithmetic of
   * comparing two small grids.
   */
  motion?: number | null
  /** The same measure against the LAST BANKED photo: is this view new? */
  novelty?: number | null
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
    lastMovedAtMs: null,
    movedSinceBank: false,
    ended: null,
  }
}

/** Stop the cadence for a reason the caller knows — the operator, usually. */
export function endCadence(state: CadenceState, reason: SweepEndReason): CadenceState {
  if (state.ended) return state
  return { ...state, ended: reason }
}

/**
 * A frame was drawn, encoded and banked. The only thing that moves the tally.
 *
 * It is also where `movedSinceBank` is spent, rather than at the moment
 * {@link tickCadence} decides to take a photo: an encode that came back empty
 * is not a photo, and a position whose only attempt failed has to stay eligible
 * for the next one.
 */
export function noteCaptured(state: CadenceState): CadenceState {
  return { ...state, captured: state.captured + 1, movedSinceBank: false }
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
    //
    // `lastMovedAtMs` goes with it. Android stops the feed, so the picture is
    // trivially unchanging for as long as the page is away — and without this
    // the sheet came back accusing a perfectly good sweep of having jammed for
    // the length of the background. Measured 2026-08-30 in a background tab:
    // "the view has not moved for 73 seconds" over a gimbal that had been
    // turning until 31 seconds earlier.
    return {
      state: { ...state, stalledSinceMs: null, lastCurrentTime: -1, seenLive: false, lastMovedAtMs: null },
      action: 'wait',
    }
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

  // What the picture itself is doing, recorded whether or not it is time for a
  // photo — the stillness warning is about the view, not about the cadence.
  const motion = typeof tick.motion === 'number' && Number.isFinite(tick.motion) ? tick.motion : null
  const novelty = typeof tick.novelty === 'number' && Number.isFinite(tick.novelty) ? tick.novelty : null
  if (motion !== null) {
    next = motion > VIEW_SETTLED
      ? { ...next, lastMovedAtMs: tick.nowMs, movedSinceBank: true }
      // The first measured look starts the stillness clock; without it a sweep
      // whose view never moves at all would report zero seconds still forever.
      : { ...next, lastMovedAtMs: next.lastMovedAtMs ?? tick.nowMs }
  }

  // Frozen, but not yet long enough to call it off. Bank nothing meanwhile —
  // the frame on offer is the same one already banked. Nor before the picture
  // has been watched to move at all.
  if (next.stalledSinceMs !== null || !next.seenLive) return { state: next, action: 'wait' }

  const sinceAttempt = next.lastAttemptMs === null ? Infinity : tick.nowMs - next.lastAttemptMs
  if (sinceAttempt < SWEEP_SAMPLE_MS) return { state: next, action: 'wait' }

  const bank = { state: { ...next, lastAttemptMs: tick.nowMs }, action: 'capture' as const }

  // Nothing measurable about the picture: the plain 700 ms clock, which is what
  // this module was before, and what a page whose canvas will not read back
  // still gets. Never a refusal — a sweep that cannot measure itself is still a
  // sweep, and photographing it on a clock is exactly what it used to do.
  if (motion === null || novelty === null) return bank

  // The floor. Ahead of the gate on purpose: a sweep that has gone four seconds
  // without a photo gets one whatever the thresholds think, which is what makes
  // VIEW_SETTLED and VIEW_NEW safe to be wrong about.
  if (sinceAttempt >= SWEEP_FORCE_BANK_MS) return bank

  // Arrived somewhere new and stopped smearing.
  if (motion <= VIEW_SETTLED && novelty >= VIEW_NEW && next.movedSinceBank) return bank

  return { state: next, action: 'wait' }
}

/**
 * Mean absolute difference between two small grids of the picture, 0-1.
 *
 * Null when either side is missing or they are different shapes, which is how
 * the first look, a canvas that would not read back, and a camera that changed
 * resolution mid-sweep all arrive at {@link tickCadence} as "not measured"
 * rather than as a fabricated zero. A fabricated zero would read as a
 * perfectly still view and trip the jam warning on a sweep that is fine.
 */
export function viewDifference(a: Uint8Array | null, b: Uint8Array | null): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!)
  return total / (a.length * 255)
}

/**
 * How long the view has been sitting still, in ms. Zero while it is moving,
 * and zero while nothing has been measured — see `lastMovedAtMs`.
 */
export function viewStillMs(state: CadenceState, nowMs: number): number {
  if (state.lastMovedAtMs === null) return 0
  return Math.max(0, nowMs - state.lastMovedAtMs)
}

/**
 * The line that tells an operator who has left the room that it has stopped
 * turning.
 *
 * Null until {@link SWEEP_STILL_WARN_MS}, because a sweep pausing is normal and
 * a screen that cries wolf at every dwell is a screen nobody reads across a
 * room. It names what the photos will be if this is left alone — that is the
 * fact that was missing from "48 photos" — and it does not stop the sweep: the
 * photos already taken are good ones, and the operator is the only one who can
 * tell a jam from a slow arc.
 */
export function sweepMotionNotice(stillMs: number): string | null {
  if (!Number.isFinite(stillMs) || stillMs < SWEEP_STILL_WARN_MS) return null
  const seconds = Math.floor(stillMs / 1000)
  return `The view has not moved for ${seconds} seconds — every photo since then is of the same wall. `
    + 'Check the phone is still turning; the photos already taken are fine either way.'
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
