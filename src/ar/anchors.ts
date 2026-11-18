/**
 * Runtime anchors: where an AR runtime can pin a point to the real world, offered as an optional accelerator behind
 * one capability. Never the foundation. The Place frame is still built from the taps (src/ar/project-calibration.ts);
 * every caller must work when `provider.anchors` is undefined or an anchor request answers null; and nothing here is
 * evidence for the word "verified" (ADR 0005 rules 3 and 5), because no measurement yet says an anchor stays put.
 *
 * Scope. Runtime anchors exist only in Chrome on Android (ARCore), Quest Browser and Android XR Chrome, the browsers that
 * implement the WebXR Anchors Module, and nowhere else. They are inert in the Capacitor shells' WebViews (MDN's
 * browser-compat-data has XRAnchor `false` for Android WebView, and mobile/README.md records WebXR as unavailable in both
 * WebViews) and on iPhone (Safari has no WebXR AR). The 8th Wall and native providers have no `anchors` member, so
 * `provider.anchors` is undefined for them and a calibration there runs on its taps alone. Persistence, below, is narrower
 * again: Quest Browser only, because Chrome on Android has none. A store build would need the native ARKit and ARCore
 * bridge for any anchor path. That bridge is the `ScanAR` plugin the shells register (src/ar/native.ts), and it offers the page
 * none: `provider.anchors` is undefined while its native session runs, the iOS plugin has no anchor method, and the Android
 * plugin's one origin anchor is never called by the page.
 *
 * A runtime anchor is not the calibration anchor. The calibration anchor (src/world/anchor-marker.ts,
 * src/world/anchor-placement.ts, ScanCalibration) is the Place's landmark and heading marker, a point in the project frame
 * drawn as a decal. A runtime anchor is the AR runtime's own tracked point, which a calibration marker may optionally be
 * paired with; the two share nothing but the word.
 *
 * What is here:
 * - AnchorCapability: createAnchor, anchorPose, anchorDisplacement, rebase, release, onMoved, onLost, onReturned, onExpired, and the
 *   persistence calls.
 * - WebXRAnchors: the WebXR Anchors Module behind it. src/ar/webxr.ts requests the 'anchors' feature as OPTIONAL, hands
 *   this class every XR frame, and disposes it on stop. Providers with no anchors (8th Wall, native today) omit it.
 * - tryCreateAnchor: the one call a caller needs, so an anchor can neither throw into nor stall a calibration.
 * - A device-local store of persistent-anchor UUIDs for Quest Browser, with persistAnchor, restoreAnchors and
 *   forgetPersistedAnchor.
 *
 * Where it runs. WebXR anchors are for Chrome on Android (with ARCore), Quest Browser and Chrome on Android XR. They are inert
 * everywhere else this app runs: `XRAnchor` is false in Android WebView, so in the Capacitor Android shell (Chromium issue
 * 40652382, via MDN browser-compat-data); Safari has no WebXR immersive-ar, so none on iPhone or in the Capacitor iOS shell; and
 * the iOS web bridges that were read document no anchors. There `provider.anchors` is undefined, as it is for the default 8th Wall
 * provider, and every caller works without it. A store build's route to a real anchor is the native ARKit and ARCore plugin
 * (`ScanAR`, src/ar/native.ts), which is built for the camera and the hit test and not for this; the other native design,
 * the unregistered `ArSession` plugin and its provider src/ar/native-provider.ts, is not the route either.
 * docs/operations/AR_DEVICE_SUPPORT.md has the matrix, its sources and the exit plan. None of this was run on a device.
 *
 * What an anchor event means. An anchor that moves, or stops being located, in the session frame says that the frame is no
 * longer the one earlier points were recorded in: the same fact as a reference-space 'reset' or a pose jump. So these events
 * are frame discontinuities, to be handled by the one-scan-one-frame rule of the epoch mechanism (src/ar/frame-epoch.ts): the
 * scan holding the earlier points is finished and the next one is calibrated again in the new epoch. src/ar/anchor-epochs.ts
 * forwards them to the provider's tracker, which tests a move's `step` (the movement since the last report) against its
 * shift thresholds and keeps `total`, how far the anchor is from where it was first located (or last rebased), as the epoch's
 * drift: a slow correction never reaches the step thresholds, only the sum, and `step` stays near the report threshold
 * however far the frame creeps. The alternative is the thing NOT to build: recomputing sessionToProject from anchor.anchorSpace each
 * frame. A scan carries one matrix, points recorded before a correction sit in the old frame, and a matrix that follows
 * the anchor would put the scan's later points in one frame and its earlier ones in another with nothing to say so.
 * tests/unit/node/wp-17a-anchor-guard.test.ts fails if any other module starts reading an anchor's pose.
 *
 * Loss is not the end of a handle at once. In the Anchors Module an anchor that the device no longer tracks leaves the tracked set
 * for good. Chromium's sources (device/vr/android/arcore/arcore_impl.cc and third_party/blink/renderer/modules/xr/xr_session.cc,
 * read on 2026-11-16 and not run on a device) read as if, while tracking is lost, Chrome can list an anchor with no pose or
 * leave it out of the set for the frames the loss lasts. DX6 has not confirmed either, or whether the same anchor object comes
 * back. So an anchor that is not located is reported lost at once (onLost) and its handle is kept for
 * ANCHOR_RETURN_WINDOW_MS: located again in time, it is reported (onReturned, after any move it made while away); not in time,
 * the handle is dead (onExpired) and whatever held it places a new one. An object that Chrome might hand back in place of a lost
 * one cannot be told from any other, so it is not adopted: the old handle expires. Whether a loss is an epoch is for the tracker
 * to say, and it does not call a blip one (src/ar/frame-epoch.ts, "What a runtime anchor adds"). The window does not run while the
 * session is hidden: no frame comes then, so nothing could have located the anchor, and a person who switches apps for half a
 * minute has not lost the room's anchor.
 *
 * Where an anchor is attached. createAnchor() takes a pose and makes the anchor with XRFrame.createAnchor(), which the
 * Anchors Module says is not attached to any real-world object. The module's other route, XRHitTestResult.createAnchor(),
 * attaches the anchor to the plane or point that was hit where the device can, so it can follow that surface as the system
 * refines it. This file does not use that route: a hit result is only usable inside the XR frame that produced it, the hit
 * test (hitTestAsync in webxr.ts) hands back plain numbers, and reaching the result means changing that function, which
 * this package may only hook (WP-05 and WP-09 own it). The numbers are used in the next frame or later, up to
 * ANCHOR_REQUEST_TIMEOUT_MS after the tap, so an anchor made here is only as good as the session frame was between the two.
 * Whether an attached anchor drifts less is UNVERIFIED; DX6 can compare the two.
 *
 * What is never deleted. An anchor that holds a persistent handle is not passed to XRAnchor.delete() by this class's own
 * cleanup (release, loss, the capability turning off, dispose, a restore that answers late). The Anchors Module leaves the
 * persistent map alone when an anchor is deleted, but one Quest 3 developer reports on the spec tracker (immersive-web/
 * anchors issue 79, 2026-09-03, one report, not reproduced here) that deleting a restored anchor appeared to erase its
 * saved record. The runtime ends such an anchor with the session anyway. The one way this file deletes a saved anchor is
 * deletePersistentAnchor(), which a caller asks for by name.
 *
 * Sources, read on 2026-11-16. A statement below is only made as fact where one of these says it.
 * - WebXR Anchors Module, Editor's Draft of 27 April 2026, https://immersive-web.github.io/anchors/ : the feature
 *   descriptor is 'anchors'. XRFrame.createAnchor(pose, space) and XRHitTestResult.createAnchor() reject with
 *   InvalidStateError unless the frame is active, so an anchor is created inside an XR frame callback, and its promise is
 *   settled by the next frame's update step. An anchor the device stops tracking is removed from the session's tracked set
 *   and from XRFrame.trackedAnchors, with no event. delete() stops tracking and leaves the persistent map alone.
 *   requestPersistentHandle() resolves a UUID string, the same one if the anchor already has one. XRSession.persistentAnchors,
 *   restorePersistentAnchor(uuid) and deletePersistentAnchor(uuid) work on a map kept per origin and marked unstable, reject
 *   with InvalidStateError for an unknown uuid, and the user agent may drop entries for any reason, for instance when the
 *   system's maximum is reached for all maps for all origins. It says nothing about what happens to anchors when a session ends.
 * - MDN browser-compat-data, api/XRAnchor.json and api/XRSession.json: XRAnchor from Chrome and Chrome Android 85, not in
 *   Firefox or Safari (so not iPhone Safari). requestPersistentHandle, persistentAnchors, restorePersistentAnchor and
 *   deletePersistentAnchor are `false` for Chrome (so Chrome Android) and 31.2 for Quest Browser. XRSession.enabledFeatures
 *   is Chrome 111, so an older Chrome cannot say which features it granted.
 * - WebXR Device API, https://immersive-web.github.io/webxr/ : a feature descriptor in optionalFeatures that the browser
 *   does not recognise is ignored, so asking for 'anchors' cannot stop a session from starting, and
 *   XRSession.enabledFeatures lists what was granted. XRFrame.getPose() gives null when a pose cannot be found. MDN's
 *   XRAnchor example spells the session key `requireFeatures`; the dictionary member is `requiredFeatures`.
 * - Meta, Quest Browser WebXR mixed reality, https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/ :
 *   persistence is requestPersistentHandle on an anchor and restorePersistentAnchor on the session; a site can hold 8
 *   persistent anchors at a time; clearing the site's history deletes them; they do not persist in a private session. The
 *   page does not mention persistentAnchors, deletePersistentAnchor, the 'anchors' descriptor or any prompt, and does not say
 *   whether the anchors sync to other devices.
 * - The spec tracker, immersive-web/anchors issues 79, 87 and pull request 80 (read 2026-11-16, third-party reports, none
 *   reproduced here): on a Quest 3 (OculusBrowser/150) persistentAnchors listed blank strings, which a Quest Browser
 *   engineer acknowledged as a bug in a recent build, and was reported empty or not shrinking after deletes; a Quest Browser
 *   engineer gave the maximum as 8 without saying per site or per browser; requestPersistentHandle failed with
 *   InvalidStateError "Maximum number of anchors reached!", deletePersistentAnchor with OperationError "Anchor deletion
 *   failed" and InvalidStateError "already being restored or deleted", restorePersistentAnchor with OperationError "Anchor
 *   creation failed"; restorePersistentAnchor was said to return a new object on every call. Issue 87 (open) asks whether
 *   persistentAnchors holds only what the current session persisted or restored, and a reviewer on pull request 80 read the
 *   spec as starting each session's map empty.
 * UNVERIFIED, because no source settles it (DX6 on a Chrome ARCore phone and on a Quest settles each):
 * - how far an anchor made from a pose (XRFrame.createAnchor) drifts from the real world over 60 s and over 10 min, and so
 *   whether the adopted move thresholds below are the right size;
 * - whether Meta's limit of 8 is per site or shared by the whole browser (Meta's page says "a site"; the module text, and the
 *   description that opens issue 79, say across all origins), what an over-limit request does on each Quest Browser
 *   version, and whether deleting an anchor frees its slot (issue 79 reports it did not);
 * - whether Quest Browser asks the user before it grants 'anchors', and whether restorePersistentAnchor resolves, rejects
 *   or never settles for an anchor saved in another room;
 * - what XRSession.persistentAnchors holds on Quest Browser at the start of a session, and whether it lists blank entries.
 *   Nothing here decides anything from that list: it is only reported (persistentAnchorIds);
 * - whether XRAnchor.delete() on a restored anchor erases its saved record (see "What is never deleted"), and whether a
 *   second restorePersistentAnchor of one uuid returns the same object (the module) or a new one (the Quest report). This
 *   file tolerates both: one uuid is one handle;
 * - whether restorePersistentAnchor works, in the session that made it, for an anchor whose live object was deleted
 *   there. The spec keeps the XRAnchor object in the map, and iwer rejects that restore. This file restores in a later
 *   session, which is the use it is built for;
 * - that the persistent handles stay on the device and are not synced (Meta's page does not say; this file only promises
 *   that it never uploads or syncs its own list of them);
 * - whether a runtime that grants 'anchors' physically holds them. An emulator does not: in node_modules/iwer (read, and
 *   driven by scratch scripts that are not tests) the emulated Quest 3 lists 'anchors' as supported, and its persistent
 *   anchors are an offset matrix kept in localStorage. "Anchors granted" therefore means "the API exists", never "the room
 *   is pinned".
 */
import { wrapDeg, type PoseLike } from '../capture/pose-delta.ts'
import { RUNTIME_ANCHOR_STORE_KEY } from '../shared/storage-keys.ts'

/** The feature descriptor the Anchors Module introduces, as requestSession() takes it. */
export const ANCHORS_FEATURE = 'anchors'

/**
 * The most persistent anchors this app keeps at once: 5, the lowest figure anyone reports for Quest Browser, so that
 * this list fills before the browser's own limit does. The reports disagree. Meta's page says a site can hold 8 persistent
 * anchors at a time. The minutes of the Immersive Web Working Group call of 2026-03-24 record "We limit sites to 5 UUIDs
 * per origin" (https://www.w3.org/2026/03/24-immersive-web-irc; the log's speaker attribution is inconsistent). On the
 * spec tracker (immersive-web/anchors issue 79) a Quest Browser engineer gave the maximum as 8, the issue's own text says
 * the browser holds a limited number across all origins, one Quest 3 developer reports getting only about 6, and two
 * developers report that deleting handles did not free slots. So the cap may be 5, 6 or 8, and it may be shared with every
 * other site's anchors, which this app cannot see: a list that reaches 8 here could already be refused by the browser.
 * Adopted, not measured (ADR 0005 rule 5): DX6 probes the cap on a headset, from a second origin too, and its result
 * replaces this number.
 */
export const MAX_PERSISTENT_ANCHORS = 5

/**
 * How far an anchor must move in the session frame, since it was last reported, before onMoved fires: 1 cm.
 * Adopted, not measured (ADR 0005 rule 5). It only stops sub-millimetre jitter from flooding listeners; whether a move
 * counts as a frame discontinuity is for the epoch rule to decide, from the `total` each event carries. DX6's 60 s and
 * 10 min anchor-drift logs should set it.
 */
export const ANCHOR_MOVED_TRANSLATION_M = 0.01

/**
 * How far an anchor must turn, in any direction, since it was last reported, before onMoved fires: half a degree, which
 * is about a centimetre of arc at one metre. Adopted, not measured (ADR 0005 rule 5); see ANCHOR_MOVED_TRANSLATION_M.
 */
export const ANCHOR_MOVED_ROTATION_DEG = 0.5

/**
 * How long one anchor request (create, restore, persist) may wait before it answers null. Without a bound, a runtime
 * that never settles would stall whoever awaits it, and the resolver and calibration both do. Adopted, not measured
 * (ADR 0005 rule 5), like HIT_TEST_TIMEOUT_MS in webxr.ts.
 */
export const ANCHOR_REQUEST_TIMEOUT_MS = 2_000

/**
 * How long an anchor may go without being located (left out of the tracked set, or listed with no pose) before its handle is given
 * up and onExpired says the Place needs a new one: 15 s. It is longer than the 3 and 10 s losses that device experiment DX6 plans
 * (cover the camera for 3, 10 and 30 s), so a brief loss is not a re-place, and shorter than the 30 s one, so a long loss is. An
 * anchor that comes back sooner is the same handle, and its return is reported. Time the session spends hidden is not counted: no
 * frame comes then.
 *
 * Adopted, not measured (ADR 0005 rule 5). Revisit when DX6 has recorded whether Chrome gives the same anchor back after a loss, and
 * after how long.
 */
export const ANCHOR_RETURN_WINDOW_MS = 15_000

/**
 * In how many separate sessions the browser must refuse to restore a saved anchor before restoreAnchors drops it from
 * this device's list. A refusal is not proof the browser lost the anchor (a Quest Browser rejects for several reasons,
 * and persistentAnchors cannot be trusted to say), so one visit never forgets anything. Adopted, not measured (ADR 0005
 * rule 5). Without any rule, entries the browser lost would fill the list and refuse every new anchor.
 */
export const ANCHOR_FORGET_AFTER_REFUSALS = 3

/**
 * How old a saved anchor must be, on top of ANCHOR_FORGET_AFTER_REFUSALS, before restoreAnchors drops it: a week. A
 * fresh anchor refused three times in an afternoon is more likely a bug or another room than a cleared history. Adopted,
 * not measured (ADR 0005 rule 5).
 */
export const ANCHOR_FORGET_AFTER_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** An anchor of one session. Opaque: only the capability that returned it can read it, and it dies with that session. */
export interface AnchorHandle {
  readonly id: string
}

/** How far, and which way, an anchor is from an earlier pose of its own, in the session frame. */
export interface AnchorMovement {
  /** Straight-line distance, metres. */
  translationM: number
  /** Total turn about any axis, degrees, 0 to 180. This is what the report threshold tests. */
  rotationDeg: number
  /**
   * The signed turn about the vertical (world +Y) inside that rotation, degrees in (-180, 180], counter-clockwise from
   * above positive: the sign convention of src/capture/pose-delta.ts, so it means the same as any other yaw in the app.
   * It is the twist about +Y, not a difference of two extracted headings, so an anchor whose own +Y is not vertical (one
   * made on a wall) reports a small yaw for a small tilt.
   */
  yawDeg: number
}

/** An anchor moved in the session frame. */
export interface AnchorMovedEvent {
  handle: AnchorHandle
  /**
   * Since the last report. Reports are spaced by the thresholds, so a slow drift is many small steps and this alone never
   * says how far the frame has gone.
   */
  step: AnchorMovement
  /**
   * Since the anchor was first located, or since rebase(handle). This is the figure to compare with a threshold: it grows
   * with a slow correction, which `step` does not.
   */
  total: AnchorMovement
  /** Where the anchor is now, in the session frame. */
  pose: PoseLike
  /** The XR frame's timestamp, ms. */
  atMs: number
}

/** How the runtime stopped locating an anchor: it is not in XRFrame.trackedAnchors (`'left-set'`), or it is and has no pose (`'no-pose'`, how a paused anchor reads). */
export type AnchorLossKind = 'left-set' | 'no-pose'

/**
 * The runtime stopped locating an anchor that it had located (or took one out of the tracked set before locating it). It may come
 * back: the handle stays valid for ANCHOR_RETURN_WINDOW_MS, and onReturned or onExpired follows. Reported once for each time it goes.
 */
export interface AnchorLostEvent {
  handle: AnchorHandle
  /** The XR frame's timestamp, ms. */
  atMs: number
  /** How it stopped being located. The first way, when it changes before it is located again. */
  how: AnchorLossKind
}

/** The runtime locates an anchor again that it had stopped locating: the same handle, which is usable again. */
export interface AnchorReturnedEvent {
  handle: AnchorHandle
  /** The XR frame's timestamp, ms. */
  atMs: number
  /** How long it was not located, ms. */
  awayMs: number
}

/**
 * An anchor was not located again within ANCHOR_RETURN_WINDOW_MS. The handle is dead for the rest of the session, the runtime has been
 * told to drop it (unless it holds a persistent handle), and whatever depended on it places a new one.
 */
export interface AnchorExpiredEvent {
  handle: AnchorHandle
  /** The XR frame's timestamp, ms. */
  atMs: number
  /** How long it was not located, ms. */
  awayMs: number
}

/**
 * What asking a runtime to restore a saved anchor came to. `refused` is the browser rejecting the request, for any
 * reason: it does not say the browser has lost the anchor. `no-answer` is everything else that is not a handle: no answer
 * in time, a call that threw, a runtime that cannot restore, or a session that is over.
 */
export type RestoreResult = { status: 'restored'; handle: AnchorHandle } | { status: 'refused' } | { status: 'no-answer' }

/**
 * What a runtime that can hold anchors offers. Optional on ARProvider (`provider.anchors`): a runtime without it leaves
 * the member undefined and the app works as it did, on taps alone.
 */
export interface AnchorCapability {
  /** True where the runtime can keep an anchor across sessions: Quest Browser. Chrome Android cannot. */
  readonly supportsPersistence: boolean
  /**
   * Pins a point in the session frame to the real world. `at` is a pose in that frame, and a HitResult from the hit-test
   * path is accepted as it is. Resolves on a later XR frame (an anchor can only be made inside one), or null if the runtime
   * refuses, has no anchors, is gone, or does not answer in ANCHOR_REQUEST_TIMEOUT_MS. It never rejects.
   */
  createAnchor(at: PoseLike): Promise<AnchorHandle | null>
  /** Where the runtime now puts the anchor, in the session frame. Null while it cannot locate it, and after it expires or is released. */
  anchorPose(handle: AnchorHandle): PoseLike | null
  /**
   * How far the anchor is now from where it was first located (or last rebased), in the session frame. The same figure as
   * `total` on the latest move event, but current to the last frame. Null until the anchor has been located, while it
   * cannot be, and after it expires or is released.
   */
  anchorDisplacement(handle: AnchorHandle): AnchorMovement | null
  /** Starts measuring `total` and anchorDisplacement from where the anchor is now. For the start of an epoch. */
  rebase(handle: AnchorHandle): void
  /**
   * Gives the anchor back. It does not fire onLost. An anchor that holds a persistent handle is only forgotten here, not
   * deleted (see "What is never deleted" in the header): the runtime ends it with the session, and the saved record stays.
   */
  release(handle: AnchorHandle): void
  /** Calls `listener` when an anchor has moved. Returns the function that stops the calls. */
  onMoved(listener: (event: AnchorMovedEvent) => void): () => void
  /** Calls `listener` when the runtime stops locating an anchor, which may come back. Returns the function that stops the calls. */
  onLost(listener: (event: AnchorLostEvent) => void): () => void
  /** Calls `listener` when an anchor that was lost is located again, after the move it made while away if it made one. Returns the function that stops the calls. */
  onReturned(listener: (event: AnchorReturnedEvent) => void): () => void
  /** Calls `listener` when an anchor was not located again in time and its handle is dead: place a new one. Returns the function that stops the calls. */
  onExpired(listener: (event: AnchorExpiredEvent) => void): () => void
  /**
   * Asks the browser to keep the anchor across sessions. Resolves its UUID, or null if it cannot (see supportsPersistence).
   * Waits at most ANCHOR_REQUEST_TIMEOUT_MS. A UUID that arrives after that stays on the live anchor, so asking again for
   * the same anchor returns it at once; one for an anchor that has been given back is deleted again. One that arrives after
   * the session has ended cannot be taken back (there is no session to ask), and stays in the browser unnamed.
   */
  requestPersistentHandle(handle: AnchorHandle): Promise<string | null>
  /** The UUID this anchor already has, or null. Answers at once, without asking the browser. */
  persistentIdOf(handle: AnchorHandle): string | null
  /**
   * Brings a kept anchor back. One uuid is one live anchor: asking again while it is live, or while an earlier ask is still
   * waiting on the browser, gives the same handle and asks the browser nothing. See RestoreResult.
   */
  restorePersistentAnchor(uuid: string): Promise<RestoreResult>
  /** Deletes a kept anchor, and the live anchor made from it. True if the browser did. */
  deletePersistentAnchor(uuid: string): Promise<boolean>
  /**
   * What the browser lists as kept for this site, without blank entries, or null when it does not say. Reported, never an
   * authority: it may be empty at the start of a session, and blank or stale on Quest Browser builds (see the header).
   */
  persistentAnchorIds(): readonly string[] | null
}

/** Knobs for WebXRAnchors. Every one has a default above; tests and DX6 set their own. */
export interface AnchorOptions {
  movedTranslationM?: number
  movedRotationDeg?: number
  requestTimeoutMs?: number
  returnWindowMs?: number
}

// --- pose helpers ------------------------------------------------------------------------------------------------

const RAD_TO_DEG = 180 / Math.PI

function copyPose(pose: PoseLike): PoseLike {
  return {
    position: { x: pose.position.x, y: pose.position.y, z: pose.position.z },
    rotation: { x: pose.rotation.x, y: pose.rotation.y, z: pose.rotation.z, w: pose.rotation.w },
  }
}

/** Finite numbers, and a rotation that is not all zeros. XRRigidTransform cannot be built from anything less. */
function isUsablePose(pose: PoseLike | null | undefined): pose is PoseLike {
  if (!pose || !pose.position || !pose.rotation) return false
  const { x, y, z } = pose.position
  const q = pose.rotation
  const numbers = [x, y, z, q.x, q.y, q.z, q.w]
  return numbers.every((n) => typeof n === 'number' && Number.isFinite(n)) && (q.x !== 0 || q.y !== 0 || q.z !== 0 || q.w !== 0)
}

/**
 * The rotation that takes `from` to `to`: to times the conjugate of from, in the Hamilton convention. Not normalised, which
 * the two callers do not need: they take ratios of its parts.
 */
function relativeRotation(from: PoseLike['rotation'], to: PoseLike['rotation']): PoseLike['rotation'] {
  return {
    x: -to.w * from.x + to.x * from.w - to.y * from.z + to.z * from.y,
    y: -to.w * from.y + to.x * from.z + to.y * from.w - to.z * from.x,
    z: -to.w * from.z - to.x * from.y + to.y * from.x + to.z * from.w,
    w: to.w * from.w + to.x * from.x + to.y * from.y + to.z * from.z,
  }
}

/**
 * The angle, in degrees, of the turn that takes rotation `a` to rotation `b`: 0 to 180, whichever way it goes, and the
 * same for q and -q. Two equal rotations give 0 to within rounding (under 1e-13 degrees). Taken as an arctangent of the
 * relative rotation's parts, so a quaternion that is a rounding error off unit length cannot give NaN (an arccosine of
 * 1.0000000000000002 would).
 */
export function rotationAngleDeg(a: PoseLike['rotation'], b: PoseLike['rotation']): number {
  const r = relativeRotation(a, b)
  return 2 * Math.atan2(Math.hypot(r.x, r.y, r.z), Math.abs(r.w)) * RAD_TO_DEG
}

/**
 * The turn about world +Y that is part of the turn from `a` to `b`, degrees in (-180, 180], counter-clockwise from above
 * positive. This is the twist of the relative rotation about the vertical axis. Differencing two headings extracted from
 * the poses instead (src/capture/pose-delta.ts) is right for a camera but not for an anchor whose own +Y lies flat, such
 * as one made on a wall: it jumps by about 90 degrees for a one degree tilt.
 */
export function yawAboutVerticalDeg(a: PoseLike['rotation'], b: PoseLike['rotation']): number {
  const r = relativeRotation(a, b)
  return wrapDeg(2 * Math.atan2(r.y, r.w) * RAD_TO_DEG)
}

function movementBetween(from: PoseLike, to: PoseLike): AnchorMovement {
  return {
    translationM: Math.hypot(to.position.x - from.position.x, to.position.y - from.position.y, to.position.z - from.position.z),
    rotationDeg: rotationAngleDeg(from.rotation, to.rotation),
    yawDeg: yawAboutVerticalDeg(from.rotation, to.rotation),
  }
}

function toTransform(pose: PoseLike): XRRigidTransform {
  const { x, y, z } = pose.position
  return new XRRigidTransform({ x, y, z, w: 1 }, { ...pose.rotation })
}

/** The runtime's pose for an anchor in `base`, or null when it cannot say. A deleted anchor throws on anchorSpace. */
function locate(frame: XRFrame, anchor: XRAnchor, base: XRSpace): PoseLike | null {
  try {
    const found = frame.getPose(anchor.anchorSpace, base)
    if (!found) return null
    const { position: p, orientation: q } = found.transform
    const pose = { position: { x: p.x, y: p.y, z: p.z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } }
    return isUsablePose(pose) ? pose : null
  } catch {
    return null
  }
}

/** Tells the runtime to stop tracking an anchor. A runtime that has already torn it down may throw; nothing is left to do then. */
function dropAnchor(anchor: XRAnchor): void {
  try {
    anchor.delete()
  } catch {
    // Already gone.
  }
}

function emit<T>(listeners: ReadonlySet<(event: T) => void>, event: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (e) {
      // A listener's bug must not stop the frame loop or the other listeners.
      console.error('[anchors] a listener threw:', e)
    }
  }
}

// --- the WebXR implementation -------------------------------------------------------------------------------------

interface Tracked {
  handle: AnchorHandle
  anchor: XRAnchor
  /** The persistent UUID, once requestPersistentHandle or restorePersistentAnchor has given one. */
  uuid: string | null
  /** Where the runtime located it in the latest frame, or null while it cannot. */
  pose: PoseLike | null
  /** Where `total` is measured from: the first sighting, or where rebase() was called. Null until located. */
  origin: PoseLike | null
  /** The pose the next step is measured from: the first sighting, then each report. */
  reported: PoseLike | null
  /** deletePersistentAnchor() is waiting on the browser: the runtime may drop the anchor as part of it, which is not a loss. */
  deleting: boolean
  /** True once the runtime has given a pose for it. A null pose before that is "not yet", not a loss. */
  located: boolean
  /**
   * Since when, and how, the runtime has not located it, and how much of that time no frame could have located it (the session was
   * hidden), which the window does not count. Null while it is located.
   */
  away: { sinceMs: number; how: AnchorLossKind; excusedMs: number } | null
}

/** One request that waits on the runtime. It is settled once, by the answer or by the timeout. */
interface Job {
  live: boolean
  timer: ReturnType<typeof setTimeout>
  resolve: (handle: AnchorHandle | null) => void
}

interface CreateJob extends Job {
  at: PoseLike
}

const noAnswer = (): RestoreResult => ({ status: 'no-answer' })

/**
 * The anchors of one WebXR session. Make it with createWebXRAnchors(), call onFrame() from the XR frame callback, and
 * dispose() it when the session ends. Anchors can only be created inside a frame callback, so createAnchor() waits for the
 * next onFrame().
 */
export class WebXRAnchors implements AnchorCapability {
  readonly supportsPersistence: boolean
  private readonly session: XRSession
  private readonly movedTranslationM: number
  private readonly movedRotationDeg: number
  private readonly requestTimeoutMs: number
  private readonly returnWindowMs: number
  private readonly tracked = new Map<string, Tracked>()
  private readonly queue: CreateJob[] = []
  private readonly jobs = new Set<Job>()
  /** Restores the browser has not answered yet, by uuid: a second ask joins the first, since the browser refuses a repeat. */
  private readonly restoring = new Map<string, Promise<XRAnchor>>()
  private readonly movedListeners = new Set<(event: AnchorMovedEvent) => void>()
  private readonly lostListeners = new Set<(event: AnchorLostEvent) => void>()
  private readonly returnedListeners = new Set<(event: AnchorReturnedEvent) => void>()
  private readonly expiredListeners = new Set<(event: AnchorExpiredEvent) => void>()
  private nextId = 1
  private disposed = false
  /** A frame came without createAnchor or trackedAnchors: this runtime has no anchors whatever enabledFeatures said. */
  private apiMissing = false
  /** The frame time of the last frame read, so the time a hidden session took can be told from a frame that was merely slow. */
  private lastFrameMs: number | null = null
  /** The session was shown again, and the next frame is the first since: see `excuseHiddenTime`. */
  private resumed = false

  constructor(session: XRSession, options: AnchorOptions = {}) {
    this.session = session
    this.movedTranslationM = options.movedTranslationM ?? ANCHOR_MOVED_TRANSLATION_M
    this.movedRotationDeg = options.movedRotationDeg ?? ANCHOR_MOVED_ROTATION_DEG
    this.requestTimeoutMs = options.requestTimeoutMs ?? ANCHOR_REQUEST_TIMEOUT_MS
    this.returnWindowMs = options.returnWindowMs ?? ANCHOR_RETURN_WINDOW_MS
    this.supportsPersistence = typeof session.restorePersistentAnchor === 'function'
  }

  /** False once disposed, and once a frame has shown that this runtime has no anchors. webxr.ts then reports no capability. */
  get usable(): boolean {
    return !this.disposed && !this.apiMissing
  }

  createAnchor(at: PoseLike): Promise<AnchorHandle | null> {
    if (!this.usable || !isUsablePose(at)) return Promise.resolve(null)
    return new Promise((resolve) => {
      // The timer made by newJob() settles this very object, so the pose is added to it rather than copied into a new one.
      this.queue.push(Object.assign(this.newJob(resolve), { at: copyPose(at) }))
    })
  }

  anchorPose(handle: AnchorHandle): PoseLike | null {
    const entry = this.lookup(handle)
    return entry?.pose ? copyPose(entry.pose) : null
  }

  anchorDisplacement(handle: AnchorHandle): AnchorMovement | null {
    const entry = this.lookup(handle)
    return entry?.origin && entry.pose ? movementBetween(entry.origin, entry.pose) : null
  }

  rebase(handle: AnchorHandle): void {
    const entry = this.lookup(handle)
    if (!entry) return
    // An anchor that cannot be located now has no "here" to start from: its next sighting is the new start.
    entry.origin = entry.pose
    entry.reported = entry.pose
  }

  /**
   * Starts measuring `total` and anchorDisplacement from where each anchor is now, for every anchor the runtime is locating: the
   * start of an epoch for all of them, which is when the provider calls it. An anchor that is away has no pose, so it is left alone: it
   * has no "here" to start from, and its return, displaced or not, is what an epoch is judged by, which a rebase would hide. Not in
   * AnchorCapability: a caller that holds a handle rebases that one.
   */
  rebaseLocated(): void {
    for (const entry of this.tracked.values()) {
      if (!entry.pose) continue
      entry.origin = entry.pose
      entry.reported = entry.pose
    }
  }

  /**
   * The session was hidden and has been shown again: the provider that watches its visibility says so. A hidden session gets no frames,
   * so an anchor that was away before it was hidden was not away from anything a frame could have located, for as long as it lasted,
   * and the first frame after this does not count that time against its window. Not in AnchorCapability: nothing but the provider
   * that owns the session knows. Without it a frame gap counts as the time it is, which is right for a frame that is merely late.
   */
  noteResumed(): void {
    this.resumed = true
  }

  release(handle: AnchorHandle): void {
    const entry = this.lookup(handle)
    if (!entry) return
    this.tracked.delete(entry.handle.id)
    this.letGo(entry)
  }

  onMoved(listener: (event: AnchorMovedEvent) => void): () => void {
    this.movedListeners.add(listener)
    return () => {
      this.movedListeners.delete(listener)
    }
  }

  onLost(listener: (event: AnchorLostEvent) => void): () => void {
    this.lostListeners.add(listener)
    return () => {
      this.lostListeners.delete(listener)
    }
  }

  onReturned(listener: (event: AnchorReturnedEvent) => void): () => void {
    this.returnedListeners.add(listener)
    return () => {
      this.returnedListeners.delete(listener)
    }
  }

  onExpired(listener: (event: AnchorExpiredEvent) => void): () => void {
    this.expiredListeners.add(listener)
    return () => {
      this.expiredListeners.delete(listener)
    }
  }

  async requestPersistentHandle(handle: AnchorHandle): Promise<string | null> {
    const entry = this.lookup(handle)
    if (!entry || !this.supportsPersistence) return null
    if (entry.uuid) return entry.uuid
    const anchor = entry.anchor
    const request = anchor.requestPersistentHandle
    if (typeof request !== 'function') return null
    // Called from a promise so that a throw is a refusal like any other.
    const asked = Promise.resolve().then(() => request.call(anchor))
    let waiting = true
    asked.then(
      (late) => {
        if (!waiting && typeof late === 'string' && late !== '') this.keepLateHandle(entry, late)
      },
      () => undefined,
    )
    const uuid = await this.within<string | null>(asked, null)
    waiting = false
    if (typeof uuid !== 'string' || uuid === '') return null
    entry.uuid = uuid
    return uuid
  }

  persistentIdOf(handle: AnchorHandle): string | null {
    return this.lookup(handle)?.uuid ?? null
  }

  restorePersistentAnchor(uuid: string): Promise<RestoreResult> {
    const restore = this.session.restorePersistentAnchor
    if (!this.usable || typeof restore !== 'function' || typeof uuid !== 'string' || uuid === '') return Promise.resolve(noAnswer())
    const live = this.byUuid(uuid)
    if (live) return Promise.resolve({ status: 'restored', handle: live.handle })
    let source = this.restoring.get(uuid)
    if (!source) {
      try {
        source = Promise.resolve(restore.call(this.session, uuid))
      } catch {
        return Promise.resolve(noAnswer())
      }
      const asked = source
      this.restoring.set(uuid, asked)
      const answered = (): void => {
        if (this.restoring.get(uuid) === asked) this.restoring.delete(uuid)
      }
      // Registered first, so the anchor is kept before any waiting ask reads it back, and kept even if every ask gave up.
      asked.then((anchor) => {
        answered()
        this.keepRestored(uuid, anchor)
      }, answered)
    }
    const waitingOn = source
    return new Promise((resolve) => {
      let refused = false
      const job = this.newJob((handle) => resolve(handle ? { status: 'restored', handle } : refused ? { status: 'refused' } : noAnswer()))
      waitingOn.then(
        () => this.finish(job, this.byUuid(uuid)?.handle ?? null),
        () => {
          refused = true
          this.finish(job, null)
        },
      )
    })
  }

  async deletePersistentAnchor(uuid: string): Promise<boolean> {
    const remove = this.session.deletePersistentAnchor
    if (!this.usable || typeof remove !== 'function') return false
    // The browser deletes the live anchor together with its persistent entry. That is this app's own doing, so it must
    // not read as a loss. The entries stay tracked until the browser confirms, so a refusal leaves them owned and released.
    const held = [...this.tracked.values()].filter((entry) => entry.uuid === uuid)
    for (const entry of held) entry.deleting = true
    let asked: Promise<boolean>
    try {
      asked = Promise.resolve(remove.call(this.session, uuid)).then(() => true)
    } catch {
      asked = Promise.resolve(false)
    }
    const deleted = await this.within<boolean>(asked, false)
    for (const entry of held) {
      if (deleted) this.tracked.delete(entry.handle.id)
      else entry.deleting = false
    }
    return deleted
  }

  persistentAnchorIds(): readonly string[] | null {
    const ids = this.session.persistentAnchors
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id !== '') : null
  }

  /**
   * The XR frame callback's turn. Makes the anchors that were asked for, then reads every anchor's pose and reports the ones
   * that moved or were lost. `refSpace` is the space `at` was given in, which is the one poses are read in.
   */
  onFrame(frame: XRFrame, refSpace: XRSpace | null, atMs: number): void {
    const previous = this.lastFrameMs
    this.lastFrameMs = atMs
    if (this.resumed) {
      this.resumed = false
      if (previous !== null) this.excuseHiddenTime(atMs - previous)
    }
    try {
      this.step(frame, refSpace, atMs)
    } catch (e) {
      // Runs inside the render loop of an optional feature: whatever goes wrong here must not stop the frames.
      console.error('[anchors] a frame step failed, so anchors are off for this session:', e)
      this.turnOff()
    }
  }

  private step(frame: XRFrame, refSpace: XRSpace | null, atMs: number): void {
    if (!this.usable) return
    if (typeof frame.createAnchor !== 'function') return this.turnOff()
    // With nothing asked for and nothing held, a frame costs one check: this runs at the headset's refresh rate.
    if (!refSpace || (this.queue.length === 0 && this.tracked.size === 0)) return
    for (const job of this.queue.splice(0)) {
      if (!job.live) continue
      try {
        const created = frame.createAnchor(toTransform(job.at), refSpace)
        if (created) this.adoptCreated(job, created)
        else this.finish(job, null)
      } catch (e) {
        console.warn('[anchors] createAnchor threw:', e)
        this.finish(job, null)
      }
    }
    const inFrame = frame.trackedAnchors
    if (!inFrame) return this.turnOff()
    this.read(frame, refSpace, inFrame, atMs)
  }

  /**
   * Gives every anchor back and stops reporting. The session is over, so this is silent: a loss that is only the session
   * ending is not news to whoever was listening, and must not start a re-anchor in a session that no longer exists.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.giveEverythingUp()
    this.movedListeners.clear()
    this.lostListeners.clear()
    this.returnedListeners.clear()
    this.expiredListeners.clear()
  }

  /**
   * The first frame after `noteResumed()`: the time since the last one, the hidden time and what came with it, does not count against
   * the return window of an anchor that was already away. What an anchor reports it was away for is still the whole of it
   * (AnchorReturnedEvent.awayMs says how long it was not located, not how long the window was running). A frame that is merely late is
   * not excused: only a gap that a hidden session explains.
   */
  private excuseHiddenTime(gapMs: number): void {
    if (!(gapMs > 0)) return
    for (const entry of this.tracked.values()) if (entry.away) entry.away.excusedMs += gapMs
  }

  /** A frame showed this runtime has no anchors, whatever enabledFeatures said: stop, and let whoever waits go. */
  private turnOff(): void {
    this.apiMissing = true
    this.giveEverythingUp()
  }

  private giveEverythingUp(): void {
    for (const job of [...this.jobs]) this.finish(job, null)
    this.queue.length = 0
    this.restoring.clear()
    for (const entry of this.tracked.values()) this.letGo(entry)
    this.tracked.clear()
  }

  /** Ends an anchor this class held, unless it holds a saved handle: see "What is never deleted" in the header. */
  private letGo(entry: Tracked): void {
    if (!entry.uuid) dropAnchor(entry.anchor)
  }

  private read(frame: XRFrame, refSpace: XRSpace, inFrame: ReadonlySet<XRAnchor>, atMs: number): void {
    for (const entry of [...this.tracked.values()]) {
      const listed = inFrame.has(entry.anchor)
      if (!listed && entry.deleting) {
        // A persistent delete the app asked for takes the live anchor with it, which is not a loss.
        this.tracked.delete(entry.handle.id)
        continue
      }
      const pose = listed ? locate(frame, entry.anchor, refSpace) : null
      entry.pose = pose
      if (!pose) {
        this.notLocated(entry, listed ? 'no-pose' : 'left-set', atMs)
        continue
      }
      entry.located = true
      const away = entry.away
      entry.away = null
      if (!entry.origin || !entry.reported) {
        entry.origin = pose
        entry.reported = pose
      } else {
        const step = movementBetween(entry.reported, pose)
        if (step.translationM >= this.movedTranslationM || step.rotationDeg >= this.movedRotationDeg) {
          entry.reported = pose
          emit(this.movedListeners, { handle: entry.handle, step, total: movementBetween(entry.origin, pose), pose: copyPose(pose), atMs })
        }
      }
      // After the move it made while away, so whoever hears both sees the move first.
      if (away) emit(this.returnedListeners, { handle: entry.handle, atMs, awayMs: atMs - away.sinceMs })
    }
  }

  /** An anchor the runtime did not locate in this frame: the start of its absence, or one more frame of it. */
  private notLocated(entry: Tracked, how: AnchorLossKind, atMs: number): void {
    if (entry.away) {
      if (atMs - entry.away.sinceMs - entry.away.excusedMs >= this.returnWindowMs) this.expire(entry, atMs)
      return
    }
    // A null pose from an anchor the runtime has never located is "not yet", which is not a loss.
    if (how === 'no-pose' && !entry.located) return
    entry.away = { sinceMs: atMs, how, excusedMs: 0 }
    emit(this.lostListeners, { handle: entry.handle, atMs, how })
  }

  /** The anchor did not come back in time. Its handle is dead, and the runtime is told to drop it unless it holds a saved handle. */
  private expire(entry: Tracked, atMs: number): void {
    const awayMs = entry.away ? atMs - entry.away.sinceMs : 0
    this.tracked.delete(entry.handle.id)
    this.letGo(entry)
    emit(this.expiredListeners, { handle: entry.handle, atMs, awayMs })
  }

  /** The entry for a handle this instance made. A handle from an earlier session carries an id that may repeat, so identity decides. */
  private lookup(handle: AnchorHandle): Tracked | undefined {
    const entry = this.tracked.get(handle.id)
    return entry && entry.handle === handle ? entry : undefined
  }

  private byUuid(uuid: string): Tracked | undefined {
    for (const entry of this.tracked.values()) if (entry.uuid === uuid) return entry
    return undefined
  }

  private track(anchor: XRAnchor, uuid: string | null): Tracked {
    const handle: AnchorHandle = Object.freeze({ id: `anchor-${this.nextId++}` })
    const entry: Tracked = { handle, anchor, uuid, pose: null, origin: null, reported: null, deleting: false, located: false, away: null }
    this.tracked.set(handle.id, entry)
    return entry
  }

  private newJob(resolve: (handle: AnchorHandle | null) => void): Job {
    const job: Job = { live: true, resolve, timer: setTimeout(() => this.finish(job, null), this.requestTimeoutMs) }
    this.jobs.add(job)
    return job
  }

  private finish(job: Job, handle: AnchorHandle | null): void {
    if (!job.live) return
    job.live = false
    clearTimeout(job.timer)
    this.jobs.delete(job)
    job.resolve(handle)
  }

  /**
   * Settles `job` with the anchor `source` delivers. An anchor that arrives after the job gave up, or after dispose(), has
   * no owner, so it is deleted rather than left tracked for the rest of the session. (A restored anchor is not handled
   * here: it is kept, see keepRestored.)
   */
  private adoptCreated(job: Job, source: Promise<XRAnchor>): void {
    source.then(
      (anchor) => {
        if (!job.live || !this.usable) {
          dropAnchor(anchor)
          this.finish(job, null)
          return
        }
        this.finish(job, this.track(anchor, null).handle)
      },
      () => this.finish(job, null),
    )
  }

  /**
   * Tracks a restored anchor under its uuid, whoever is still waiting for it. One that arrives after every ask gave up is
   * kept, not deleted: the next ask for the uuid is answered with it, and deleting a saved anchor is the one thing this class
   * does not do on its own (see the header). The browser handing back an object that is already tracked is the same anchor.
   */
  private keepRestored(uuid: string, anchor: XRAnchor): void {
    if (!this.usable) return
    for (const entry of this.tracked.values()) {
      if (entry.anchor !== anchor) continue
      entry.uuid ??= uuid
      return
    }
    this.track(anchor, uuid)
  }

  /** A persistent handle that came after the wait for it ended. */
  private keepLateHandle(entry: Tracked, uuid: string): void {
    if (this.disposed) return
    if (this.tracked.get(entry.handle.id) === entry) {
      entry.uuid ??= uuid
      return
    }
    // The anchor was given back while the browser was still answering, so nothing can name this handle: give its slot back.
    void this.deletePersistentAnchor(uuid)
  }

  /** The answer of a runtime call, or `fallback` if it rejects, or does not settle in time. */
  private within<T>(call: Promise<T>, fallback: T): Promise<T> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), this.requestTimeoutMs)
      call.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        () => {
          clearTimeout(timer)
          resolve(fallback)
        },
      )
    })
  }
}

/**
 * The anchors of `session`, or null when the browser says it did not grant the 'anchors' feature. A browser that cannot
 * say (no enabledFeatures: Chrome before 111) gets an instance, which turns itself off at the first frame that shows the
 * API is missing. Either way the session itself was never refused over anchors: they are only ever an optional feature.
 */
export function createWebXRAnchors(session: XRSession, options: AnchorOptions = {}): WebXRAnchors | null {
  const granted = session.enabledFeatures
  if (Array.isArray(granted) && !granted.includes(ANCHORS_FEATURE)) return null
  return new WebXRAnchors(session, options)
}

/**
 * Asks the provider for an anchor, for a caller that must not depend on one. Null if the provider has none, if it refuses,
 * if it throws, or if it has not answered after `timeoutMs` (twice the request timeout of WebXRAnchors by default, so
 * its own bound answers first). A handle that arrives after this gave up is released at once, since nobody holds it.
 */
export async function tryCreateAnchor(
  provider: { readonly anchors?: AnchorCapability },
  at: PoseLike,
  timeoutMs: number = ANCHOR_REQUEST_TIMEOUT_MS * 2,
): Promise<AnchorHandle | null> {
  const capability = provider.anchors
  if (!capability) return null
  let gaveUp = false
  let stopWaiting: (answer: null) => void = () => undefined
  const timedOut = new Promise<null>((resolve) => {
    stopWaiting = resolve
  })
  const timer = setTimeout(() => {
    gaveUp = true
    stopWaiting(null)
  }, timeoutMs)
  const asked = Promise.resolve().then(() => capability.createAnchor(at))
  const answer = await Promise.race([asked.then((handle) => handle, () => null), timedOut])
  clearTimeout(timer)
  if (gaveUp) {
    void asked.then(
      (late) => {
        // A capability whose release throws must not turn a courtesy into an unhandled rejection.
        try {
          if (late) capability.release(late)
        } catch {
          // Nothing more can be done for a handle nobody holds.
        }
      },
      () => undefined,
    )
  }
  return answer
}

// --- persistent anchors: the device-local list of UUIDs --------------------------------------------------------------

/** The part of Storage the list needs. Tests pass a fake; the app passes nothing and gets localStorage. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** One kept anchor, and what it marks. */
export interface PersistedAnchor {
  /** The browser's handle for it, from requestPersistentHandle. */
  uuid: string
  /** The Place (WorldProject id) it belongs to. */
  projectId: string
  /** What it marks, e.g. 'landmark' or 'heading-marker'. */
  role: string
  /** When this device saved it, ms since the epoch. */
  savedAtMs: number
  /** The Place frame it belongs to, once the Place frame record carries an id. */
  frameId?: string
  /** In how many separate sessions, in a row, the browser refused to restore it. Absent when none. See ANCHOR_FORGET_AFTER_REFUSALS. */
  refusals?: number
}

export type SaveOutcome = { ok: true } | { ok: false; reason: 'full' | 'storage-unavailable' | 'invalid' }

export interface PersistentAnchorStore {
  /** The entries that read back whole. A corrupt value, or one entry that is malformed, costs only what is unreadable. */
  list(): PersistedAnchor[]
  /** Adds the entry, or replaces the one with the same uuid. A uuid that is new is refused once MAX_PERSISTENT_ANCHORS are kept. */
  save(entry: PersistedAnchor): SaveOutcome
  /** Forgets one entry. True if there was one and the list was written. */
  remove(uuid: string): boolean
}

const STORE_VERSION = 1

/**
 * The longest text the list will keep in any field. A UUID is 36 characters, so this only stops a corrupt or hostile value
 * from filling the key. Adopted, not measured (ADR 0005 rule 5).
 */
const MAX_STORED_TEXT_LENGTH = 256

function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage
  } catch {
    // Blocked storage (private windows, cleared site data, a sandboxed frame) can throw on access.
    return undefined
  }
}

function isShortText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STORED_TEXT_LENGTH
}

function parseEntry(raw: unknown): PersistedAnchor | null {
  if (raw === null || typeof raw !== 'object') return null
  const { uuid, projectId, role, savedAtMs, frameId, refusals } = raw as Record<string, unknown>
  if (!isShortText(uuid) || !isShortText(projectId) || !isShortText(role)) return null
  if (typeof savedAtMs !== 'number' || !Number.isFinite(savedAtMs)) return null
  return {
    uuid,
    projectId,
    role,
    savedAtMs,
    ...(isShortText(frameId) ? { frameId } : {}),
    ...(typeof refusals === 'number' && Number.isSafeInteger(refusals) && refusals > 0 ? { refusals } : {}),
  }
}

/** The stored entries, or null when the storage cannot be read at all. Corrupt content reads as an empty list. */
function readEntries(storage: StorageLike): PersistedAnchor[] | null {
  let raw: string | null
  try {
    raw = storage.getItem(RUNTIME_ANCHOR_STORE_KEY)
  } catch {
    return null
  }
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const stored = parsed !== null && typeof parsed === 'object' ? (parsed as { anchors?: unknown }).anchors : undefined
  if (!Array.isArray(stored)) return []
  const seen = new Set<string>()
  const entries: PersistedAnchor[] = []
  for (const item of stored) {
    const entry = parseEntry(item)
    if (entry && !seen.has(entry.uuid)) {
      seen.add(entry.uuid)
      entries.push(entry)
    }
  }
  return entries
}

function writeEntries(storage: StorageLike, entries: PersistedAnchor[]): boolean {
  try {
    storage.setItem(RUNTIME_ANCHOR_STORE_KEY, JSON.stringify({ version: STORE_VERSION, anchors: entries }))
    return true
  } catch {
    return false
  }
}

/**
 * The list of kept anchors on this device. It lives in one localStorage key, so it is per browser profile, goes when the
 * site's data does, and is never sent anywhere or synced: the UUIDs mean something only to the browser that made them.
 */
export function createPersistentAnchorStore(storage?: StorageLike): PersistentAnchorStore {
  const backing = (): StorageLike | undefined => storage ?? browserStorage()
  return {
    list(): PersistedAnchor[] {
      const target = backing()
      return (target && readEntries(target)) || []
    },
    save(entry: PersistedAnchor): SaveOutcome {
      const valid = parseEntry(entry)
      if (!valid) return { ok: false, reason: 'invalid' }
      const target = backing()
      const entries = target ? readEntries(target) : null
      if (!target || !entries) return { ok: false, reason: 'storage-unavailable' }
      const at = entries.findIndex((kept) => kept.uuid === valid.uuid)
      if (at >= 0) entries[at] = valid
      else if (entries.length >= MAX_PERSISTENT_ANCHORS) return { ok: false, reason: 'full' }
      else entries.push(valid)
      return writeEntries(target, entries) ? { ok: true } : { ok: false, reason: 'storage-unavailable' }
    },
    remove(uuid: string): boolean {
      const target = backing()
      const entries = target ? readEntries(target) : null
      if (!target || !entries) return false
      const left = entries.filter((kept) => kept.uuid !== uuid)
      return left.length < entries.length && writeEntries(target, left)
    },
  }
}

export type PersistOutcome =
  | { ok: true; uuid: string }
  | {
      ok: false
      reason: 'unsupported' | 'runtime-refused' | 'store-full' | 'storage-unavailable'
      /** Set when the browser kept the anchor, this list could not record it, and the browser would not give it back. */
      orphanedUuid?: string
    }

/**
 * Keeps one anchor across sessions and writes down what it marks. A full list is refused before the browser is asked, so
 * no slot is spent and the live anchor is left alone. If the browser kept the anchor but this device could not record it,
 * the browser's copy is deleted again (which ends the live anchor too), because an entry nothing can name would still count
 * against the browser's limit; `orphanedUuid` names it when even that failed. A uuid the list already held is left alone.
 * 'runtime-refused' also covers a handle this list cannot hold.
 */
export async function persistAnchor(
  anchors: AnchorCapability,
  store: PersistentAnchorStore,
  handle: AnchorHandle,
  owner: { projectId: string; role: string; frameId?: string },
  nowMs: number = Date.now(),
): Promise<PersistOutcome> {
  if (!anchors.supportsPersistence) return { ok: false, reason: 'unsupported' }
  if (!anchors.persistentIdOf(handle) && store.list().length >= MAX_PERSISTENT_ANCHORS) return { ok: false, reason: 'store-full' }
  const uuid = await anchors.requestPersistentHandle(handle)
  if (!uuid) return { ok: false, reason: 'runtime-refused' }
  const alreadyKept = store.list().some((kept) => kept.uuid === uuid)
  const saved = store.save({
    uuid,
    projectId: owner.projectId,
    role: owner.role,
    savedAtMs: nowMs,
    ...(owner.frameId ? { frameId: owner.frameId } : {}),
  })
  if (saved.ok) return { ok: true, uuid }
  const given = alreadyKept ? true : await anchors.deletePersistentAnchor(uuid)
  const reason = saved.reason === 'full' ? 'store-full' : saved.reason === 'storage-unavailable' ? 'storage-unavailable' : 'runtime-refused'
  return given ? { ok: false, reason } : { ok: false, reason, orphanedUuid: uuid }
}

export interface RestoredAnchor {
  entry: PersistedAnchor
  handle: AnchorHandle
}

export interface RestoreOutcome {
  /** False when this runtime cannot keep anchors: nothing was tried and the list was not touched. */
  supported: boolean
  /** Live again in this session. */
  restored: RestoredAnchor[]
  /**
   * Not placed: the browser refused, did not answer in time, or the device is in another room. The entries are kept, with
   * the count of sessions the browser has refused them in.
   */
  unresolved: PersistedAnchor[]
  /** The browser refused them in ANCHOR_FORGET_AFTER_REFUSALS separate sessions and they are old enough. The entries were removed. */
  forgotten: PersistedAnchor[]
}

/** Which anchors of which capability have already been counted as refused in this session. One session counts once. */
const refusedThisSession = new WeakMap<object, Set<string>>()

/**
 * Brings back the kept anchors of a Place, one at a time (a browser may refuse new anchors while others are waiting, so a
 * hung restore delays the next by at most ANCHOR_REQUEST_TIMEOUT_MS). Every entry is asked for: the browser's own list
 * (persistentAnchorIds) is not consulted, because it cannot be trusted to name what the browser still holds, and an entry
 * the browser merely did not list would otherwise be lost for good. A restore the browser refuses counts against the entry
 * once per session; only ANCHOR_FORGET_AFTER_REFUSALS such sessions, on an entry at least ANCHOR_FORGET_AFTER_AGE_MS old,
 * remove it. An answer that is only slow or missing counts for nothing, so a visit to the wrong room cannot erase the right
 * anchor, and a restore that works clears the count.
 */
export async function restoreAnchors(
  anchors: AnchorCapability,
  store: PersistentAnchorStore,
  filter: { projectId?: string; frameId?: string } = {},
  nowMs: number = Date.now(),
): Promise<RestoreOutcome> {
  const outcome: RestoreOutcome = { supported: anchors.supportsPersistence, restored: [], unresolved: [], forgotten: [] }
  if (!outcome.supported) return outcome
  const counted = refusedThisSession.get(anchors) ?? new Set<string>()
  refusedThisSession.set(anchors, counted)
  const wanted = store
    .list()
    .filter((entry) => (!filter.projectId || entry.projectId === filter.projectId) && (!filter.frameId || entry.frameId === filter.frameId))
  for (const entry of wanted) {
    const result = await anchors.restorePersistentAnchor(entry.uuid)
    if (result.status === 'restored') {
      outcome.restored.push({ entry, handle: result.handle })
      if (entry.refusals) store.save({ ...entry, refusals: 0 })
      continue
    }
    if (result.status !== 'refused' || counted.has(entry.uuid)) {
      outcome.unresolved.push(entry)
      continue
    }
    counted.add(entry.uuid)
    const refusals = (entry.refusals ?? 0) + 1
    if (refusals >= ANCHOR_FORGET_AFTER_REFUSALS && nowMs - entry.savedAtMs >= ANCHOR_FORGET_AFTER_AGE_MS && store.remove(entry.uuid)) {
      outcome.forgotten.push({ ...entry, refusals })
      continue
    }
    store.save({ ...entry, refusals })
    outcome.unresolved.push({ ...entry, refusals })
  }
  return outcome
}

/**
 * Deletes a kept anchor in the browser and on this list, and reports each half. The list entry goes only once the browser
 * has let go of the anchor (or the runtime cannot keep anchors at all): an entry removed while the browser still holds the
 * anchor would leave something nothing can name, which still counts against the browser's limit. If the browser refuses
 * because it no longer holds the anchor, the entry stays until restoreAnchors drops it or the caller calls store.remove().
 */
export async function forgetPersistedAnchor(
  anchors: AnchorCapability,
  store: PersistentAnchorStore,
  uuid: string,
): Promise<{ runtime: boolean; store: boolean }> {
  if (!anchors.supportsPersistence) return { runtime: false, store: store.remove(uuid) }
  const runtime = await anchors.deletePersistentAnchor(uuid)
  return { runtime, store: runtime ? store.remove(uuid) : false }
}
