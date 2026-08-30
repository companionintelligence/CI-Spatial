/**
 * The tripod path: sweep the room from one spot, carry the tripod, sweep again.
 *
 * This is the third capture path, beside the live AR scanner and Upload
 * Content, and the only one that needs no AR runtime at all — which is the
 * whole reason it exists. On the test phone (XREAL Beam Pro) native AR is
 * permanently unavailable and the 8th Wall engine starts about two attempts in
 * eight, so the two existing paths are, between them, a coin flip and a video
 * upload that catalogues nothing.
 *
 * The rule this module enforces, and the reason it is a state machine and not
 * a counter, is that ONE sweep is not a capture. Measured on real runs:
 *
 *     one spot, sweeping in place       3 of 17 photos usable   unusable
 *     five spots, a sweep at each      36 of 36 photos usable   9,914 points
 *     walking the room with a phone    48 of 48 photos usable
 *
 * A sweep from a fixed tripod sees the room from exactly one place, however
 * many photos it takes, and a room cannot be rebuilt from that. What makes it
 * work is the tripod MOVING between sweeps — ordinary multi-setup surveying,
 * the same reason a laser scanner is set down in several corners of a room
 * rather than spun once in the middle. So `finishVerdict()` refuses fewer than
 * STATION_MIN spots outright, and `endSweep()` refuses a sweep that produced
 * no photos: both are the shapes an empty-but-successful capture would take.
 *
 * Split out of main.ts, and pure, for the same reason `upload-expectation.ts`
 * and `preflight.ts` are: the interesting cases here are copy and refusals,
 * both of which are worth testing without a browser, a camera, or a gimbal.
 *
 * Register: no job names, no reconstruction vocabulary. Someone standing in
 * their living room with a tripod needs to know which spot they are on and
 * when to pick it up, and nothing else.
 */

/**
 * Fewest spots that can produce a room. Below this the capture is not "a bit
 * worse" — it does not reconstruct at all (3 of 17 above), so this is a refusal
 * threshold and not a warning.
 */
export const STATION_MIN = 3

/** What five measured: 36 of 36. The number the UI proposes by default. */
export const STATION_RECOMMENDED = 5

/**
 * A ceiling, so a mistyped target cannot ask someone to carry a tripod around
 * a living room twenty times. Nothing above five has been measured; more spots
 * are not harmful, they are just unevidenced.
 */
export const STATION_MAX = 8

/** One finished sweep, and how much of it the app actually saw. */
export interface StationSweep {
  /** Photos handed to the app from this spot. Never zero — `endSweep` refuses. */
  photos: number
}

export type StationPhase =
  /** Tripod is down at a spot, nothing running. The sweep has not started. */
  | 'ready'
  /** A sweep is running at the current spot. */
  | 'sweeping'
  /** The sweep at this spot is finished. The tripod has to move. */
  | 'move'
  /** Handed off for upload. Terminal. */
  | 'done'

export interface StationCaptureState {
  /** How many spots this capture is aiming for, clamped to [MIN, MAX]. */
  readonly target: number
  readonly phase: StationPhase
  /** Finished spots, in order. `length` is the only progress that counts. */
  readonly spots: readonly StationSweep[]
  /** Photos gathered so far in the sweep currently running. */
  readonly pending: number
  /**
   * The last sweep ended with nothing to show for it.
   *
   * Kept in the state rather than inferred, because the screen after an empty
   * sweep must not look like the screen before a fresh one — it is the exact
   * moment someone would otherwise walk to the next spot believing this one
   * counted.
   */
  readonly lastSweepEmpty: boolean
}

export function createStationCapture(target: number = STATION_RECOMMENDED): StationCaptureState {
  const clamped = Number.isFinite(target)
    ? Math.min(STATION_MAX, Math.max(STATION_MIN, Math.round(target)))
    : STATION_RECOMMENDED
  return { target: clamped, phase: 'ready', spots: [], pending: 0, lastSweepEmpty: false }
}

/** Start the sweep at the current spot. */
export function beginSweep(state: StationCaptureState): StationCaptureState {
  if (state.phase !== 'ready') return state
  return { ...state, phase: 'sweeping', pending: 0, lastSweepEmpty: false }
}

/** Photos arrived for the sweep in progress. Additive — a sweep can add twice. */
export function addPhotos(state: StationCaptureState, count: number): StationCaptureState {
  if (state.phase !== 'sweeping') return state
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  return { ...state, pending: state.pending + safe }
}

/**
 * End the sweep at this spot.
 *
 * A sweep with no photos does NOT advance anything: the phase goes back to
 * 'ready' at the same spot with `lastSweepEmpty` set, so the UI says what
 * happened instead of counting a spot that produced nothing. This is the
 * single most likely way this feature could report success it did not earn —
 * the operator sweeps, the camera never handed anything over, and the app
 * cheerfully asks them to move the tripod.
 */
export function endSweep(state: StationCaptureState): StationCaptureState {
  if (state.phase !== 'sweeping') return state
  if (state.pending === 0) {
    return { ...state, phase: 'ready', pending: 0, lastSweepEmpty: true }
  }
  return {
    ...state,
    phase: 'move',
    spots: [...state.spots, { photos: state.pending }],
    pending: 0,
    lastSweepEmpty: false,
  }
}

/**
 * The tripod has been carried to the next spot.
 *
 * `target` grows if the operator chooses to add a spot beyond the plan — the
 * alternative is a step counter reading "Spot 6 of 5", which reads as a bug in
 * the one screen whose entire job is saying where you are. It never grows past
 * STATION_MAX, which is also where the guidance stops offering another.
 */
export function nextSpot(state: StationCaptureState): StationCaptureState {
  if (state.phase !== 'move') return state
  const target = Math.min(STATION_MAX, Math.max(state.target, state.spots.length + 1))
  return { ...state, target, phase: 'ready', pending: 0, lastSweepEmpty: false }
}

export interface FinishVerdict {
  /** Whether this capture can be sent at all. */
  ok: boolean
  headline: string
  detail: string
  /**
   * The same refusal for a screen that has already explained itself.
   *
   * `detail` carries the whole reason, for anywhere the "why more than one
   * spot" note is not on screen. In the sheet it IS on screen, directly above,
   * and repeating a paragraph under every step is how a screen stops being
   * read at all — so the sheet shows this instead: the count, and how many
   * more.
   */
  short: string
}

/**
 * Whether what has been captured is a room or a pile of photos from one place.
 *
 * The refusal names the measurement rather than a rule, because "you need
 * three" invites the reasonable question this answers: one spot has been tried
 * and it does not work.
 */
export function finishVerdict(state: StationCaptureState): FinishVerdict {
  const done = state.spots.length
  if (done >= STATION_MIN) {
    const photos = totalPhotos(state)
    return {
      ok: true,
      headline: `${done} spot${done === 1 ? '' : 's'} ready to send`,
      detail: `${photos} photo${photos === 1 ? '' : 's'} from ${done} spots around the room. They upload together as one capture of this Place.`,
      short: `${photos} photos from ${done} spots, ready to send.`,
    }
  }
  const missing = STATION_MIN - done
  return {
    ok: false,
    headline: done === 0 ? 'No spots captured yet' : `${done} spot${done === 1 ? '' : 's'} is not enough`,
    detail: `${WHY_SEVERAL_SPOTS} ${missing} more to go.`,
    short: `${done} of ${STATION_MIN} spots — ${missing} more before this can be sent.`,
  }
}

/**
 * Hand off for upload. Refuses for the same reason `finishVerdict` does — the
 * caller has to have shown the refusal, so returning the state unchanged here
 * cannot silently swallow anything.
 */
export function finishCapture(state: StationCaptureState): StationCaptureState {
  if (!finishVerdict(state).ok) return state
  return { ...state, phase: 'done', pending: 0 }
}

export function totalPhotos(state: StationCaptureState): number {
  return state.spots.reduce((sum, spot) => sum + spot.photos, 0) + state.pending
}

/** Which spot the operator is standing at, 1-based, including the one running. */
export function currentSpot(state: StationCaptureState): number {
  if (state.phase === 'done') return state.spots.length
  if (state.phase === 'move') return state.spots.length
  return state.spots.length + 1
}

/**
 * What this path is for, in the words that go at the top of the sheet.
 *
 * Both claims are load-bearing and both are measured: no AR runtime is involved
 * anywhere in it, and the live scanner genuinely does not start on the test
 * phone. What five spots measured is SHAPE — 36 of 36 photos usable, 9,914
 * points, where one spot could not be rebuilt at all.
 *
 * It said "the one capture that rebuilds a room true to size", and that was
 * false in the direction this repo keeps failing in. A capture with no AR
 * runtime has no metric reference of any kind: the reconstruction is an exact
 * similarity of the real room at an arbitrary size until something of known
 * length calibrates it (server/capture/known_distance.ts — "those captures
 * reconstruct perfectly well and then sit at an arbitrary size forever"). The
 * card one tap away already says "Size is not measured"
 * (capture-intent.ts's `COPY.tripod`), and the two are read minutes apart by
 * the same person. So this one says the same thing.
 */
export const TRIPOD_PATH_SUMMARY =
  'A phone on a tripod sweeps the room from a few spots. No AR, so it runs on phones the live scanner cannot. '
  + 'It rebuilds the shape of the room; how big it is stays unmeasured.'

/** Why one sweep is not a capture. Shown up front, and again if finish is refused. */
export const WHY_SEVERAL_SPOTS =
  'One spot on its own cannot be rebuilt — the room only comes together once the tripod has moved between sweeps. '
  + `${STATION_MIN} spots is the least that works; ${STATION_RECOMMENDED} is what we test with.`

/** Where to put them. One sentence, because it is one idea. */
export const SPREAD_HINT =
  'Spread the spots around the room, and keep them off one straight line.'

export interface StationGuidance {
  /** 'Spot 2 of 5' — which spot, and how many there are. */
  step: string
  /** What is happening or what to do, in a few words. */
  headline: string
  /** One sentence of consequence or instruction. */
  detail: string
  /** Label for the button that moves the loop on, or null while nothing can. */
  primary: string | null
  /** Whether this screen is reporting something that went wrong. */
  tone: 'normal' | 'warn'
}

/**
 * The whole station loop as one function of state: which spot, what to do now,
 * and what the button says.
 *
 * Every phase answers the four questions someone holding a tripod has — which
 * spot am I on, is the sweep running, may I move yet, and am I finished — so
 * that none of them has to be inferred from a spinner.
 */
export function stationGuidance(state: StationCaptureState): StationGuidance {
  const spot = currentSpot(state)
  const step = state.phase === 'done'
    ? `${state.spots.length} spot${state.spots.length === 1 ? '' : 's'} captured`
    : `Spot ${spot} of ${state.target}`

  if (state.phase === 'done') {
    return {
      step,
      headline: 'Capture sent',
      detail: `${totalPhotos(state)} photos from ${state.spots.length} spots are uploading. The line under the cards reports how it goes.`,
      primary: null,
      tone: 'normal',
    }
  }

  if (state.phase === 'sweeping') {
    return {
      step,
      headline: 'Sweeping — leave it alone',
      detail: 'Stand clear and let the phone pan across the room. Add its photos below, then mark the sweep finished.',
      primary: 'Sweep finished',
      tone: 'normal',
    }
  }

  if (state.phase === 'move') {
    const remaining = state.target - state.spots.length
    if (remaining <= 0) {
      const room = state.spots.length < STATION_MAX
      return {
        step,
        headline: `All ${state.target} spots done`,
        detail: room
          ? 'Send the capture, or add another spot if part of the room was never in view.'
          : `${STATION_MAX} spots is as far as this goes. Send the capture.`,
        primary: room ? 'Add another spot' : null,
        tone: 'normal',
      }
    }
    return {
      step,
      headline: `Spot ${state.spots.length} done — pick the tripod up`,
      detail: `Carry it a few steps to a spot that sees the room from a different side. ${SPREAD_HINT}`,
      primary: 'Set down at the next spot',
      tone: 'normal',
    }
  }

  if (state.lastSweepEmpty) {
    return {
      step,
      headline: 'That sweep produced no photos',
      // The loud version of the empty success. Nothing advanced, and the copy
      // has to say so, or the next tap moves a tripod for nothing.
      detail: `Spot ${spot} has not been captured, so nothing has moved on. Sweep it again and add the photos it takes.`,
      primary: 'Sweep this spot again',
      tone: 'warn',
    }
  }

  if (state.spots.length === 0) {
    return {
      step,
      headline: 'Stand the tripod where it sees most of the room',
      detail: `${SPREAD_HINT} Start the sweep once you have stepped out of the way.`,
      primary: 'Start the sweep',
      tone: 'normal',
    }
  }

  return {
    step,
    headline: 'New spot — start the sweep',
    detail: `${state.spots.length} spot${state.spots.length === 1 ? '' : 's'} captured so far. Step out of the way and sweep this one.`,
    primary: 'Start the sweep',
    tone: 'normal',
  }
}

/**
 * The same progress for `#status-text`, which is one line of about 25
 * characters on a 375 px viewport (`#status-row` is ~211 px). Anything longer
 * wraps under the quality chip, which is the defect
 * tests/mock-scanner-startup-budget.spec.ts holds the scanner status to.
 */
export const STATION_STATUS_MAX_CHARS = 28

export function stationStatusLine(state: StationCaptureState): string {
  const spot = currentSpot(state)
  switch (state.phase) {
    case 'sweeping': return `Spot ${spot}/${state.target} — sweeping`
    case 'move': return `Spot ${spot}/${state.target} — move on`
    case 'done': return `${state.spots.length} spots sent`
    default: return state.lastSweepEmpty
      ? `Spot ${spot}/${state.target} — retry`
      : `Spot ${spot}/${state.target} — ready`
  }
}
