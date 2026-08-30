// What "connected" is allowed to mean for the BLE link, and how a stale peripheral handle is
// recognized. Pure functions with no noble dependency, so both the transport and the tests can
// use them (server/ble-transport.mjs cannot be imported in a test — it pulls in the native HCI
// bindings and would take the adapter away from a running backend).
//
// ADR 0005 rule 3: a status value that claims something must be backed by a measurement. The
// measurement here is arrival of notification bytes. `connected` used to mean "noble's connect
// call came back", which is a different and much weaker claim — it stayed true through a link
// that had never subscribed to a single characteristic and would never deliver a byte.

/**
 * The link's honest state, in increasing order of what a caller may rely on:
 *
 * - `disconnected` — no GATT handle. Nothing works.
 * - `connecting`   — a connect attempt is in flight. Nothing works yet.
 * - `linked`       — a GATT handle exists, so WRITES work (this is the level `stopMotors()`
 *                    needs). Telemetry is either not subscribed, or subscribed and silent.
 *                    A closed-loop move at this level is a move with no feedback.
 * - `streaming`    — subscribed AND notification bytes arrived recently. The only level at
 *                    which anything that reads telemetry back is actually working.
 */
export const LINK = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  LINKED: 'linked',
  STREAMING: 'streaming',
};

/**
 * How long after the last notification the link still counts as streaming.
 *
 * Measured on a real OM6 over BLE on 2026-08-30, idle (no commands being sent), 500
 * notifications in 15.06s across fff4: median inter-notification gap 44ms, p95 61ms, max 75ms.
 * The gimbal streams unprompted, so silence is a fault, not idleness. 3000ms is 40x the worst
 * observed gap — generous enough that ordinary jitter or a busy event loop never trips it,
 * tight enough that a dead link is visible within three seconds instead of never.
 *
 * Note this counts ANY notification, not just the quaternion frames (cmdSet 0x4/cmdId 0x5,
 * ~1Hz in the same capture). Liveness of the link and freshness of a pose are different
 * questions: `lastQuaternionAt` answers the second one and the control loop already uses it.
 */
export const STREAM_STALE_MS = 3000;

/**
 * Derive the link state from what is actually observable. No defaults that flatter the link:
 * every unknown resolves downward.
 */
export function deriveLinkState({
  peripheralState = null,
  connecting = false,
  subscribedChars = [],
  lastNotifyAt = 0,
  now = Date.now(),
  staleAfterMs = STREAM_STALE_MS,
} = {}) {
  // `connecting` wins over a handle that already exists: mid-connect the handle is open but
  // service discovery and subscription have not run, so nothing about it can be relied on yet.
  if (connecting) return LINK.CONNECTING;
  if (peripheralState !== 'connected') return LINK.DISCONNECTED;
  // A handle with no subscription is the exact shape of the defect this module exists for:
  // connect() returned, the object looked healthy, and no notification could ever arrive.
  if (!subscribedChars.length) return LINK.LINKED;
  if (!lastNotifyAt) return LINK.LINKED;
  return now - lastNotifyAt <= staleAfterMs ? LINK.STREAMING : LINK.LINKED;
}

/** True once telemetry has been proven to flow — the only honest meaning of "connected". */
export function isStreaming(state) {
  return state === LINK.STREAMING;
}

/** True when writes can be issued. Deliberately weaker than isStreaming(): a stop command must
 * go out over a link that has stopped reporting, which is precisely when the motors are most
 * likely to be latched and driving. */
export function isLinked(state) {
  return state === LINK.LINKED || state === LINK.STREAMING;
}

/**
 * One sentence a human can act on, for the status payload, the web UI and API error bodies.
 * Says what is wrong and what to do, rather than restating the enum.
 */
export function describeLink(state, { subscribedChars = [], lastNotifyAt = 0, now = Date.now() } = {}) {
  switch (state) {
    case LINK.STREAMING:
      return `streaming telemetry on ${subscribedChars.join(', ')}`;
    case LINK.CONNECTING:
      return 'connecting';
    case LINK.LINKED:
      if (!subscribedChars.length) {
        return 'linked but not streaming: a GATT handle is open and commands can be sent, but no '
          + 'notify characteristic is subscribed, so no telemetry will ever arrive. Reconnect to '
          + 'rebuild the subscriptions.';
      }
      if (!lastNotifyAt) {
        return `linked but not streaming: subscribed to ${subscribedChars.join(', ')} and the `
          + 'gimbal has not sent a single notification. Commands can be sent, but anything that '
          + 'reads telemetry back has no feedback. Reconnect, or power-cycle the gimbal.';
      }
      return `linked but not streaming: last notification ${Math.round((now - lastNotifyAt) / 1000)}s `
        + `ago on ${subscribedChars.join(', ')}. Commands can be sent, but anything that reads `
        + 'telemetry back has no feedback.';
    default:
      return 'not connected to a gimbal — scan + connect first';
  }
}

/**
 * Recognize noble's already-connected rejection.
 *
 * noble throws `Peripheral already connected` from Noble#connect whenever its own peripheral
 * map already holds `state === 'connected'` for that id. On Linux that map can reach this state
 * WITHOUT this process ever having connected: the HCI-socket bindings see connect events for
 * every link on the adapter, not only the ones they opened, and adopt them
 * (`else if (status === 0) { this.emit('connect', uuid, null) }` in
 * lib/hci-socket/bindings.js#onLeConnComplete). So a link left open by the previous
 * `server/backend.mjs` outlives the process that made it, and the next process's very first
 * connect() is rejected against a handle it has never discovered services on.
 *
 * Matched on the message because that is all noble gives us — there is no error code. Kept
 * narrow and anchored to both words so an unrelated error is never treated as recoverable.
 */
export function isStaleHandleError(err) {
  return /peripheral\s+already\s+connected/i.test(String(err?.message ?? err ?? ''));
}

/**
 * Did the link fail in a way a fresh attempt can genuinely fix?
 *
 * Two shapes qualify:
 *
 * - The stale handle above.
 * - `Disconnected <n>` — noble rejects any GATT operation whose link drops while it is in
 *   flight (Noble#_withDisconnectHandler), with the raw HCI disconnect reason. Measured on a
 *   real OM6 over BlueZ on 2026-08-30: re-opening a link immediately after dropping a stale one
 *   fails this way roughly one attempt in three, with reason 62 (0x3E, "Connection Failed to be
 *   Established") — the controller has not finished releasing the old ACL. The next attempt
 *   succeeds. That is a race worth retrying, not a fault worth reporting.
 *
 * Deliberately NOT retryable: "Osmo service (fff0) not found" (wrong device — a retry finds the
 * same wrong device) and "no notify characteristic accepted a subscription" (the gimbal's own
 * BLE stack is wedged; the fix is the hardware button-combo reset, and retrying only delays
 * the operator learning that).
 *
 * Follows one level of `cause` so an error this module's own callers have wrapped for
 * readability is still classified on what actually went wrong.
 */
export function isTransientLinkError(err) {
  if (!err) return false;
  if (isStaleHandleError(err)) return true;
  if (/^Disconnected \d+/i.test(String(err.message ?? err))) return true;
  return Boolean(err.cause) && isTransientLinkError(err.cause);
}
