/**
 * Device AR preflight — can this phone actually run a scan, and if not, say so
 * before the user walks a room for nothing.
 *
 * Split from the providers and from main.ts so every rule here is testable
 * without an AR session, for the same reason `tracking-quality.ts` was split:
 * three separate call sites (the pre-tap probe, the `provider.start()` catch,
 * and the first-frame watchdog) have to agree on one notion of "is AR working",
 * and the interesting cases are the ones no boolean can express.
 *
 * The two failures this exists for, both caught on an XREAL Beam Pro:
 *
 * 1. No ARCore. `com.google.ar.core` is absent from the installed-package list,
 *    so `navigator.xr.isSessionSupported('immersive-ar')` answers **true** — it
 *    reports whether the API exists, not whether any service backs it — and
 *    `requestSession()` then rejects with `NotSupportedError: The specified
 *    session configuration is not supported` (src/ar/webxr.ts:120-121 requires
 *    the `hit-test` feature). A boolean probe cannot see this coming; only the
 *    rejection names it, which is why `startFailureVerdict()` exists.
 *
 * 2. 8th Wall lies by reporting ready. On the same device the engine loads,
 *    `XR8.run()` is accepted, and the camera track is acquired at 960x720 — but
 *    the pipeline never emits a frame. The startup diagnostic in
 *    `eighthwall.ts` read `"frame":"unreported"` and `"projectionAspect":null`,
 *    and no pose ever arrived. The only signal is an ABSENCE, so the verdict
 *    has to be made on a timer: `firstFrameVerdict()`.
 *
 * Nothing here decides on its own that a device is hopeless before giving it
 * time — see `'warming-up'`, which exists precisely so a slow phone is not
 * routed away from a session that was about to work.
 */

/**
 * How long to wait for the AR runtime's first pose before judging it.
 *
 * This is the SAME 5 s that `EighthWallProvider.start()` has always used for
 * its "Pose not received" console warning — that timer is now the source of the
 * verdict rather than a second, competing notion of "is it working". The
 * constant lives here so the provider and the tests read one number.
 */
export const FIRST_POSE_TIMEOUT_MS = 5_000

/**
 * What we are willing to claim about this device's ability to run a live scan.
 *
 * Deliberately four states and not a boolean: the two real-world failures above
 * are distinguishable from a merely-slow device only by *which* of these it is,
 * and collapsing `'warming-up'` into `'unavailable'` would push a working phone
 * off the AR path for being three seconds late.
 */
export type PreflightOutcome =
  /** A real pose arrived. AR is working. */
  | 'ready'
  /** Not yet — inside the grace window, or nothing has been observed. Never route away on this. */
  | 'warming-up'
  /** Frames are arriving but tracking has not converged. Fixable in the room, not by leaving. */
  | 'degraded'
  /** Never — this device cannot produce an AR session. Upload Content is the path. */
  | 'unavailable'

export interface PreflightVerdict {
  outcome: PreflightOutcome
  /**
   * One short line for `#status-text` or the Start button's `.start-path-status`
   * sub-label. Both are narrow (`#status-row` is ~211 px on a 375 px viewport,
   * about 25 characters), so these stay terse.
   */
  headline: string
  /**
   * Consequence + next step, for `#ar-help` on the start screen or the
   * permission banner. Never the runtime's own sentence: "The specified session
   * configuration is not supported" names no consequence and no next step.
   */
  detail: string
  /** Whether committing to a live AR scan is worth the user's time. */
  canScan: boolean
  /**
   * Whether Upload Content — a walkthrough video or photos, which needs no AR
   * runtime at all — is the path this device should be sent to.
   */
  routeToUpload: boolean
  /**
   * Whether `detail` is worth putting in front of someone BEFORE they commit.
   *
   * Separate from `canScan` because the interesting case is a verdict that says
   * yes and should still be read: "this browser reports AR support" is the
   * exact claim a Beam Pro also makes, and a start screen that shows that
   * sentence has told the truth, while one that shows "The AR engine loaded"
   * on a phone that is about to work fine has only added noise. Kept in the
   * verdict rather than re-derived at the call site so the rule is tested.
   */
  caveat: boolean
}

/** The sentence every dead end ends with. Upload Content builds the same map. */
// "the same map" was wrong, and wrong in the direction that costs the user time:
// an upload rebuilds the room's shape but places no objects in it. Measured on a
// real video capture — 29 segments seen, 0 placed, because a video records no
// per-frame camera position and object depth cannot be recovered without one.
// Every verdict this is appended to has already concluded the device cannot scan,
// so it must not end by recommending scanning.
const UPLOAD_NEXT_STEP =
  'Use Upload Content to add a walkthrough video or photos from this Place instead — it rebuilds the room in 3D. It will not catalogue objects: only walking the room with a phone places those, which this device cannot do.'

export interface ProbeEnv {
  /** `window.isSecureContext` — camera, WebXR and IndexedDB all require it. */
  secureContext: boolean
  /** `window.XR8` is present: the 8th Wall SLAM engine loaded. */
  xr8Loaded: boolean
  /** `navigator.xr` exists at all. */
  webxrApi: boolean
  /**
   * `navigator.xr.isSessionSupported('immersive-ar')`.
   *
   * Read this as "the API is present", NOT "AR works": on the Beam Pro it is
   * true with no ARCore installed. It is only trustworthy in the negative.
   */
  immersiveArAdvertised: boolean
}

/**
 * The cheap, pre-tap probe. Runs during boot, before the user commits.
 *
 * It is honest about its own limits: a positive answer is only ever
 * `'warming-up'`, because neither signal available before a session starts can
 * distinguish a working device from the Beam Pro. `'unavailable'` here is the
 * one thing that IS knowable up front — no engine, and no AR API to fall back
 * to — and it is worth knowing, because it means the Start button will never
 * do anything and the start screen can say so while it is still on screen.
 */
export function probeVerdict(env: ProbeEnv): PreflightVerdict {
  if (!env.secureContext) {
    return {
      outcome: 'unavailable',
      headline: 'Needs a secure (HTTPS) link',
      detail: 'The camera and AR both need an HTTPS page, so nothing can start here. Ask for the correct https:// link for this scanner.',
      canScan: false,
      routeToUpload: false,
      caveat: true,
    }
  }

  if (env.xr8Loaded) {
    // 8th Wall runs its own SLAM and needs no OS-level AR service, so a device
    // with no ARCore can still scan through it — which is exactly why the
    // engine loading tells us nothing about whether it will emit a frame.
    return {
      outcome: 'warming-up',
      headline: 'AR ready to start',
      detail: 'The AR engine loaded. Whether the camera pipeline actually produces frames on this device is checked in the first few seconds after you start.',
      canScan: true,
      routeToUpload: false,
      // Nothing actionable, and nothing a working phone needs to read.
      caveat: false,
    }
  }

  if (!env.webxrApi) {
    return {
      outcome: 'unavailable',
      headline: 'No AR on this browser',
      detail: `This browser has no AR support at all, so a live scan cannot run. ${UPLOAD_NEXT_STEP}`,
      canScan: false,
      routeToUpload: true,
      caveat: true,
    }
  }

  if (!env.immersiveArAdvertised) {
    // The negative is the trustworthy direction: a browser that declines
    // immersive-ar outright genuinely cannot open the session.
    return {
      outcome: 'unavailable',
      headline: 'AR not supported here',
      detail: `This browser cannot open an AR session, so there is nothing for the scanner to track. ${UPLOAD_NEXT_STEP}`,
      canScan: false,
      routeToUpload: true,
      caveat: true,
    }
  }

  return {
    outcome: 'warming-up',
    headline: 'AR ready to start',
    // Named, rather than presented as a green light, because this is the exact
    // claim that misled us for a week on the Beam Pro.
    detail: 'This browser reports AR support. That only means the API is present — some devices answer yes with no AR service installed, and fail when the session opens. Upload Content is always available if it does.',
    canScan: true,
    routeToUpload: false,
    // The one warming-up verdict worth reading first: this is the sentence the
    // Beam Pro's browser also produces, minutes before requestSession() fails.
    caveat: true,
  }
}

/**
 * Classify a `provider.start()` rejection into something a person can act on.
 *
 * Every outcome here is `'unavailable'` — start already failed — so the value
 * is entirely in which sentence gets shown. A permission claim has to be backed
 * by a permission error (ADR 0005 rule 3 applied to failure copy): telling
 * someone to check camera settings that were already correct is what a
 * `window.THREE does not exist` regression was reported as for weeks.
 */
export function startFailureVerdict(err: unknown): PreflightVerdict {
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)

  const isPermission = name === 'NotAllowedError'
    || name === 'SecurityError'
    || /permission|denied|NotAllowedError/i.test(message)
  if (isPermission) {
    return {
      outcome: 'unavailable',
      headline: 'Camera access is blocked',
      detail: 'Camera access is blocked, so the scanner cannot see the room. Allow camera access for this site in your browser or phone settings and reload, or use Upload Content to add a video or photos from this Place instead.',
      canScan: false,
      routeToUpload: true,
      caveat: true,
    }
  }

  // The Beam Pro signature. `requestSession()` rejects with exactly this when
  // the AR API exists but no service backs it — reloading, waiting, or checking
  // permissions will never change the answer, so say the device, not the app.
  const isUnsupportedConfig = name === 'NotSupportedError'
    || /not supported|unsupported/i.test(message)
  if (isUnsupportedConfig) {
    return {
      outcome: 'unavailable',
      headline: 'This device has no AR service',
      // Leads with the same consequence clause as the generic case on purpose:
      // it is what the failure regression test asserts reaches the screen, and
      // it is the part that is true regardless of cause. The device-specific
      // reason follows, because "retrying will not help" is the thing that
      // changes what the person does next.
      detail: `AR could not start: this device advertises AR support but has no AR service installed to back it (on Android that is Google Play Services for AR), so retrying will not help. ${UPLOAD_NEXT_STEP}`,
      canScan: false,
      routeToUpload: true,
      caveat: true,
    }
  }

  return {
    outcome: 'unavailable',
    headline: 'AR could not start on this device',
    detail: `AR could not start on this device, so there is nothing for the scanner to track. ${UPLOAD_NEXT_STEP}`,
    canScan: false,
    routeToUpload: true,
    caveat: true,
  }
}

export interface FirstFrameObservation {
  /**
   * The runtime has processed at least one camera frame.
   *
   * For 8th Wall this is the engine's own `videoWidth`/`videoHeight` hook
   * having fired — the same thing the startup diagnostic prints as
   * `frame: "unreported"` when it has not. It is NOT "the camera track was
   * acquired": on the Beam Pro the track was acquired at 960x720 and no frame
   * ever reached the pipeline.
   */
  sawCameraFrame: boolean
  /** A real 6-DoF pose arrived — the provider's `isTracking()` latch. */
  sawPose: boolean
  /** Milliseconds since the AR session started. */
  elapsedMs: number
  /** Grace window before any negative judgement. Defaults to the 5 s pose timer. */
  timeoutMs?: number
}

/**
 * The verdict that can only be reached by waiting, because the failure it
 * catches is an absence.
 *
 * The ordering is the whole point:
 *  - a pose beats everything, however late it arrives (a device that recovers
 *    at 8 s is a working device);
 *  - inside the grace window the answer is always `'warming-up'`, so nothing
 *    routes a merely-slow phone away from a session that was about to work;
 *  - past it, NO frame at all is the "never" case — the pipeline is dead, and
 *    no amount of walking the room will produce one;
 *  - past it, frames but no pose is "not yet, and here is why" — the engine is
 *    alive and SLAM has not converged, which a dark or featureless room causes
 *    and which the person can fix where they are standing.
 */
export function firstFrameVerdict(obs: FirstFrameObservation): PreflightVerdict {
  const timeoutMs = obs.timeoutMs ?? FIRST_POSE_TIMEOUT_MS

  if (obs.sawPose) {
    return {
      outcome: 'ready',
      headline: 'Tracking',
      detail: 'AR is tracking. Walk the room slowly to build the scan.',
      canScan: true,
      routeToUpload: false,
      caveat: false,
    }
  }

  if (obs.elapsedMs < timeoutMs) {
    return {
      outcome: 'warming-up',
      headline: 'Starting AR…',
      detail: 'The AR runtime is still starting. Hold the phone up and give it a few seconds.',
      canScan: true,
      routeToUpload: false,
      caveat: false,
    }
  }

  if (!obs.sawCameraFrame) {
    const seconds = Math.round(timeoutMs / 1000)
    return {
      outcome: 'unavailable',
      headline: 'No camera frames from AR',
      detail: `The AR engine reported ready but has produced no camera frame in ${seconds} seconds, so there is nothing to scan and nothing to track. This device cannot run the live scanner. ${UPLOAD_NEXT_STEP}`,
      canScan: false,
      routeToUpload: true,
      caveat: true,
    }
  }

  return {
    outcome: 'degraded',
    headline: 'AR cannot lock on yet',
    // No mention of Upload Content: this one is fixable where the person is
    // standing, and sending them away from a live camera that works would be
    // worse advice than saying nothing.
    detail: 'The camera is running but AR has not locked on. Add light, point at something with more detail than a blank wall, and move slowly.',
    canScan: true,
    routeToUpload: false,
    caveat: true,
  }
}
