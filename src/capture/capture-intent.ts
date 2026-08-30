/**
 * What are you capturing? — the question the start screen asks instead of
 * making someone choose a technology.
 *
 * The screen had grown to three capture cards named after the machinery behind
 * them ("Scan a Place" / "Upload Content" / "Tripod Scan"), and picking between
 * them needed knowledge nobody in a living room has: whether this phone runs a
 * live scan at all. On the test phone (XREAL Beam Pro) the answer is "sometimes"
 * — native AR can never run, and the in-browser engine started about two
 * attempts in eight — so the card sitting at the top of that screen was, for
 * that person, a coin flip presented as the primary path.
 *
 * So the person names the SUBJECT, and this module names the method. It is the
 * same information the start screen already had (src/ar/preflight.ts's probe,
 * whose `ProbeEnv` is what `deviceFromProbe()` consumes rather than a second
 * device model) — it is just no longer the user's job to interpret it.
 *
 * ## The ladder
 *
 * Best first, and every rung measured on real captures:
 *
 *   1. live, on the phone's own tracking — the only path that recovers real
 *      size, and the only one that places objects (17 of 17 walked keyframes
 *      carried where the camera stood, against 0 of 48 from a video)
 *   2. live, in the browser — same capture, no install, where 1 cannot run
 *   3. tripod spots — needs no tracking runtime at all: 5 spots gave 36 of 36
 *      usable photos and 9,914 points, where one spot swept in place gave 3 of
 *      17 and no room at all
 *   4. video walkthrough — 48 of 48 frames registered; runs on any camera
 *   5. photos — a drone, a DSLR, or someone else's pictures
 *
 * `resolveCapture()` walks that ladder against what the device can actually do
 * and returns the first rung that runs. Rungs 3-5 always run — they need no
 * tracking runtime, no session, and not even a secure context, because the
 * photos arrive through a file input — which is what makes "some method is
 * always recommended" a property of the function and not a hope. The unit test
 * asserts it across every shape of device this can be handed.
 *
 * ## What is deliberately NOT claimed
 *
 * Only rungs 1-2 carry `trueToSize`. A capture from rungs 3-5 reconstructs a
 * room that is a perfect similarity of the real one — exact in shape, with no
 * idea how big it is — until something of known length calibrates it. Copy that
 * implied otherwise is the failure mode this repo keeps having: a size that is
 * wrong is worse than a size that is absent, because everything downstream
 * trusts it.
 *
 * Register: what the person will DO and what they get. No runtime names, no
 * job names, no "AR" — someone photographing a chair has no reason to learn
 * which of five machines their pictures go through. The banned-vocabulary test
 * next door (tests/unit/node/upload_expectation.test.ts) is the precedent.
 */
import type { ProbeEnv } from '../ar/preflight'

/** What the person says they are capturing. The only question they are asked. */
export type CaptureSubject = 'room' | 'place' | 'object' | 'person'

/** How it gets captured. Chosen for them, never presented as a choice. */
export type CaptureMethod =
  /** Live, on the phone's own tracking. */
  | 'live-native'
  /** Live, run in the browser — no install, and no dependency on the phone's own. */
  | 'live-browser'
  /** A phone on a tripod, swept from several spots. */
  | 'tripod'
  /** A walkthrough video, uploaded. */
  | 'video'
  /** A set of stills, uploaded. */
  | 'photos'

/**
 * Three states, not a boolean, for the reason `PreflightOutcome` has four: the
 * one thing measured about this is that a browser answering "yes" to
 * `isSessionSupported('immersive-ar')` is not evidence — the Beam Pro answers
 * yes with nothing installed behind it. `'unknown'` is that answer, and it
 * still outranks the no-tracking rungs, because routing a phone away from a
 * session that was about to work is the other way to get this wrong.
 */
export type Availability = 'yes' | 'no' | 'unknown'

export interface DeviceCapture {
  /** HTTPS. Without it the camera cannot open, so no live rung can run. */
  secureContext: boolean
  /** Live capture on the phone's own tracking service. */
  nativeAr: Availability
  /** Live capture run in the browser. */
  browserAr: Availability
}

/** The control that runs a method. Existing start-screen ids — never new ones. */
export type CaptureControlId = 'start-ar-btn' | 'start-tripod-card' | 'start-upload-card'

export interface MethodPlan {
  method: CaptureMethod
  control: CaptureControlId
  /** Card title: the action, not the machinery. */
  title: string
  /** What the person will do, in one sentence they could follow holding a phone. */
  action: string
  /** What they get out of it, including what they do not. */
  result: string
  /**
   * Whether this path recovers real-world size on its own.
   *
   * True for the live rungs only. Everything else needs a known length before
   * any measurement it produces means anything.
   */
  trueToSize: boolean
}

export interface CaptureRecommendation {
  subject: CaptureSubject
  /** The one method being recommended. Always present — that is the invariant. */
  best: MethodPlan
  /**
   * The other methods that can also run here, best first. Never contains
   * `best`, and never contains a method this device cannot run — an
   * alternative that dead-ends is worse than no alternative.
   */
  alternatives: MethodPlan[]
  /**
   * Why the better rungs were skipped, when they were, or the hedge when the
   * recommended one is only probably available. Null when there is nothing
   * worth saying — a phone that is simply going to work gets a clean screen,
   * the same rule `PreflightVerdict.caveat` encodes.
   */
  note: string | null
}

/** The subject question, and its answers. Kept here so the copy is testable. */
export const SUBJECT_QUESTION = 'What are you capturing?'

export const SUBJECT_CHOICES: ReadonlyArray<{ subject: CaptureSubject, label: string }> = [
  { subject: 'room', label: 'A room' },
  { subject: 'place', label: 'Whole place' },
  { subject: 'object', label: 'An object' },
  { subject: 'person', label: 'A person' },
]

/**
 * Preference order per subject. Not one ladder, because the subject changes
 * which rung is actually best:
 *
 *  - a whole place puts video above tripod — a continuous walkthrough
 *    registered 48 of 48 frames, and carrying a tripod through every room to
 *    get the same thing is work nobody will do;
 *  - a single object has no tripod rung at all: "several spots around the
 *    room" is just photographs of the object, which is rung 5 with less
 *    ceremony;
 *  - a person is never a walkthrough. Nobody holds still long enough for
 *    one, so the live rungs record them from inside a session and everything
 *    else films them.
 */
const LADDERS: Record<CaptureSubject, readonly CaptureMethod[]> = {
  room: ['live-native', 'live-browser', 'tripod', 'video', 'photos'],
  place: ['live-native', 'live-browser', 'video', 'tripod', 'photos'],
  object: ['live-native', 'live-browser', 'photos', 'video'],
  person: ['live-native', 'live-browser', 'video', 'photos'],
}

/** Which start-screen control runs each method. Two methods share the picker. */
const CONTROLS: Record<CaptureMethod, CaptureControlId> = {
  'live-native': 'start-ar-btn',
  'live-browser': 'start-ar-btn',
  tripod: 'start-tripod-card',
  video: 'start-upload-card',
  photos: 'start-upload-card',
}

/**
 * The copy, as a table rather than a set of branches, because every cell is a
 * claim someone will act on and they are only checkable side by side.
 *
 * `result` says what does NOT come out as well as what does, everywhere it is
 * not obvious: an upload rebuilds a room and catalogues nothing in it
 * (measured — 0 of 29 candidate objects placed), and repeating that here keeps
 * the promise on the card identical to the one `upload-expectation.ts` makes
 * one tap later.
 */
const COPY: Record<CaptureMethod, Record<CaptureSubject, { title: string, action: string, result: string }>> = {
  'live-native': {
    room: {
      title: 'Walk the room',
      action: 'Hold your phone up and walk slowly round the room.',
      result: 'A 3D map at true size, with things placed as you go.',
    },
    place: {
      title: 'Walk the place',
      action: 'Hold your phone up and walk from room to room.',
      result: 'One 3D map of the whole place at true size, things placed.',
    },
    object: {
      title: 'Walk around it',
      action: 'Circle it slowly, keeping all of it in frame.',
      result: 'A 3D capture of the object at true size.',
    },
    person: {
      title: 'Record a person',
      action: 'Start the capture, then walk a slow lap around them.',
      result: 'A recording of them, kept with this Place.',
    },
  },
  // The two live rungs differ only in what runs underneath, which is exactly
  // the thing the person is no longer being asked about — so the copy is the
  // same, and the distinction survives only in `method` for the caller.
  'live-browser': {
    room: {
      title: 'Walk the room',
      action: 'Hold your phone up and walk slowly round the room.',
      result: 'A 3D map at true size, with things placed as you go.',
    },
    place: {
      title: 'Walk the place',
      action: 'Hold your phone up and walk from room to room.',
      result: 'One 3D map of the whole place at true size, things placed.',
    },
    object: {
      title: 'Walk around it',
      action: 'Circle it slowly, keeping all of it in frame.',
      result: 'A 3D capture of the object at true size.',
    },
    person: {
      title: 'Record a person',
      action: 'Start the capture, then walk a slow lap around them.',
      result: 'A recording of them, kept with this Place.',
    },
  },
  tripod: {
    room: {
      title: 'Sweep from a tripod',
      action: 'Sweep, move the tripod, sweep again — 3 to 5 spots.',
      result: 'The room rebuilt from every side. Size is not measured.',
    },
    place: {
      title: 'Sweep from a tripod',
      action: 'Sweep, carry the tripod to the next room, sweep again.',
      result: 'Each room rebuilt from every side. Size is not measured.',
    },
    // Not on any object or person ladder; present so the table is total.
    object: {
      title: 'Sweep from a tripod',
      action: 'Sweep from a tripod set down at 3 to 5 spots around it.',
      result: 'The object rebuilt from every side. Size is not measured.',
    },
    person: {
      title: 'Sweep from a tripod',
      action: 'Sweep from a tripod while they hold still, from 3 to 5 spots.',
      result: 'A still capture of the person. Size is not measured.',
    },
  },
  video: {
    room: {
      title: 'Film a walkthrough',
      action: 'Film as you walk round the room, then hand it over.',
      result: 'The room in 3D — nothing catalogued, size is not measured.',
    },
    place: {
      title: 'Film a walkthrough',
      action: 'Film as you walk from room to room, then hand it over.',
      result: 'The place in 3D — nothing catalogued, size is not measured.',
    },
    object: {
      title: 'Film it',
      action: 'Film a slow lap around it, then hand it over.',
      result: 'The object in 3D. Size is not measured.',
    },
    person: {
      title: 'Film the person',
      action: 'Film a slow lap while they hold still, then hand it over.',
      result: 'A still 3D capture; they will not move, and size is not measured.',
    },
  },
  photos: {
    room: {
      title: 'Hand over photos',
      action: 'Photos taken all round the room, from several standing spots.',
      result: 'The room in 3D — nothing catalogued, size is not measured.',
    },
    place: {
      title: 'Hand over photos',
      action: 'Photos taken all through the place, several from each room.',
      result: 'The place in 3D — nothing catalogued, size is not measured.',
    },
    object: {
      title: 'Photograph it',
      action: 'Take 20 or more photos right around it, then hand them over.',
      result: 'The object in 3D. Size is not measured.',
    },
    person: {
      title: 'Hand over photos',
      action: 'Photos taken right around them while they hold still.',
      result: 'A still 3D capture; they will not move, and size is not measured.',
    },
  },
}

/** Only the live rungs know how big anything is. Everything else is shape only. */
const TRUE_TO_SIZE: Record<CaptureMethod, boolean> = {
  'live-native': true,
  'live-browser': true,
  tripod: false,
  video: false,
  photos: false,
}

function planFor(method: CaptureMethod, subject: CaptureSubject): MethodPlan {
  const copy = COPY[method][subject]
  return {
    method,
    control: CONTROLS[method],
    title: copy.title,
    action: copy.action,
    result: copy.result,
    trueToSize: TRUE_TO_SIZE[method],
  }
}

/**
 * Can this method run on this device, as far as anything actually knows?
 *
 * The three no-tracking rungs answer `'yes'` unconditionally, and that is not
 * an optimism: they collect their frames through a file input, so they need no
 * session, no camera API and not even a secure context — which is why the
 * insecure-context path in main.ts, which returns before an AR runtime is ever
 * created, still has something to offer.
 */
function availability(method: CaptureMethod, device: DeviceCapture): Availability {
  switch (method) {
    case 'live-native':
      return device.secureContext ? device.nativeAr : 'no'
    case 'live-browser':
      return device.secureContext ? device.browserAr : 'no'
    default:
      return 'yes'
  }
}

/**
 * Pick the method, and say why the better ones were skipped.
 *
 * Order within the ladder is preference; `'yes'` outranks `'unknown'` across
 * the whole ladder, so a live rung that is only advertised does not outrank a
 * live rung that has been seen to load — but both still outrank the
 * no-tracking rungs, because "not proven yet" is not "dead" (the same reason
 * `probeVerdict()` answers `'warming-up'` rather than a boolean).
 *
 * Pure, and total: the ladders all end in rungs that answer `'yes'`, so there
 * is no device shape for which this has nothing to return.
 */
export function resolveCapture(subject: CaptureSubject, device: DeviceCapture): CaptureRecommendation {
  const ladder = LADDERS[subject]
  const runnable = ladder.filter(method => availability(method, device) !== 'no')
  const certain = runnable.filter(method => availability(method, device) === 'yes')
  const hedged = runnable.filter(method => availability(method, device) === 'unknown')

  // `certain` can never be empty — the no-tracking rungs are always in it —
  // so this ordering always yields a method. The fallback below is unreachable
  // by construction and exists so the type does not have to lie about it.
  const ordered = [...certain.filter(m => isLive(m)), ...hedged, ...certain.filter(m => !isLive(m))]
  const bestMethod = ordered[0] ?? 'photos'
  const best = planFor(bestMethod, subject)
  const alternatives = ordered.slice(1).map(method => planFor(method, subject))

  return { subject, best, alternatives, note: noteFor(bestMethod, device) }
}

function isLive(method: CaptureMethod): boolean {
  return method === 'live-native' || method === 'live-browser'
}

/**
 * The one line of "why this one".
 *
 * Only two situations earn it, and both are situations where the recommendation
 * could otherwise be read as a smaller promise than it is: a live path that is
 * advertised but unproven (say so, and name what is behind it), and a device
 * where no live path exists at all (say that too, once — the recommendation
 * below it is not a consolation prize, it is the path that works here).
 */
function noteFor(bestMethod: CaptureMethod, device: DeviceCapture): string | null {
  if (isLive(bestMethod)) {
    if (availability(bestMethod, device) === 'unknown') {
      return 'If this does not start, the other ways here still work.'
    }
    return null
  }
  const liveRuledOut = availability('live-native', device) === 'no'
    && availability('live-browser', device) === 'no'
  if (!liveRuledOut) return null
  return 'This phone cannot capture live; this one does.'
}

/**
 * Read a device out of the pre-tap probe, reusing `ProbeEnv` rather than
 * defining a second device model (ADR 0001).
 *
 * The one asymmetry is deliberate and is the whole reason this is not a copy:
 * `immersiveArAdvertised` becomes `'unknown'`, never `'yes'`. It is the exact
 * claim a Beam Pro's browser makes minutes before the session rejects, and
 * `probeVerdict()` already documents that it is trustworthy only in the
 * negative. The engine having loaded is stronger — it is a script that ran —
 * so that one does become `'yes'`.
 */
export function deviceFromProbe(env: ProbeEnv): DeviceCapture {
  return {
    secureContext: env.secureContext,
    nativeAr: env.webxrApi && env.immersiveArAdvertised ? 'unknown' : 'no',
    browserAr: env.xr8Loaded ? 'yes' : 'no',
  }
}

/**
 * Close the live rungs, for the dead ends that have no verdict to hand.
 *
 * Every way the live capture can be ruled out funnels through one place in
 * main.ts (`setStartButtonState('unavailable')`) — an insecure page, an AR
 * runtime that could not be created, a session that rejected, a crash in boot
 * — so this is what that funnel applies, rather than each call site inventing
 * the same two fields.
 *
 * It deliberately has no "reopen" counterpart. Nothing that has been found
 * permanently unable to run a live capture becomes able to again without a
 * reload, and a helper that implied otherwise would invite a caller to undo a
 * verdict on a timer — which is the mistake `firstFrameVerdict()` documents at
 * length: the phone it once condemned on a five-second sample tracked 2.37 s
 * after start on a later attempt, so what must stay revocable is the WARNING,
 * not the capability.
 */
export function withoutLiveCapture(device: DeviceCapture): DeviceCapture {
  return { ...device, nativeAr: 'no', browserAr: 'no' }
}
