// The one wire shape for phone-sensor telemetry relayed into the gimbal control client.
//
// Two independent orientation sources meet in this UI and they are NOT interchangeable:
//   - the GIMBAL's own quaternion (protocol/telemetry.mjs), which is relative to wherever the
//     gimbal booted and has no compass reference at all; and
//   - the PHONE's magnetometer heading, which is absolute (true north) but unreliable indoors
//     near steel and wiring — the exact condition this app scans in.
// ADR 0005 already fixed the rule for combining them: geometry for relative alignment, compass
// for absolute orientation. So this payload is displayed alongside gimbal telemetry, never
// silently averaged into it, and `headingAccuracyDeg` travels with the heading so the UI can
// show how much to trust it rather than presenting a bare number.
//
// Deliberately plain-JSON and dependency-free: it crosses a WebSocket between a browser page on
// the phone and a Node backend, so it cannot carry class instances or reach for Deno/DOM APIs.

/** Discriminator for phone telemetry frames on the backend's existing /ws broadcast. */
export const PHONE_TELEMETRY = 'phone-telemetry';

/**
 * @typedef {object} PhoneTelemetry
 * @property {'phone-telemetry'} type
 * @property {number|null} heading      Compass heading, degrees clockwise from TRUE north, 0-360.
 * @property {number|null} headingAccuracyDeg  Reported +/- on `heading`; null when unknown.
 * @property {number|null} pitch        Device pitch, degrees.
 * @property {number|null} roll         Device roll, degrees.
 * @property {number|null} lat
 * @property {number|null} lng
 * @property {number|null} accuracyM    GPS horizontal accuracy (68% radius).
 * @property {number|null} altitudeM
 * @property {string} at                ISO timestamp the sample was taken on the phone.
 * @property {string|null} deviceLabel  Human label, e.g. 'beam-pro-1'.
 */

/**
 * True when `msg` is a structurally valid PhoneTelemetry frame.
 *
 * Every numeric field is checked, including `headingAccuracyDeg` and `altitudeM` — an earlier
 * version omitted both, so a frame carrying `headingAccuracyDeg: "very"` validated and reached
 * consumers that then did arithmetic on a string.
 *
 * `undefined` is rejected rather than treated as absent. This validator gates a network input
 * arriving from a phone browser, and a frame that simply *omits* a field is a different thing
 * from one that explicitly sends `null`: the first is a malformed/partial sender (or a version
 * skew), the second is a sensor honestly reporting "no reading". Accepting both as equivalent
 * is what let a partial frame through as if it were complete. Senders should call
 * {@link normalizePhoneTelemetry}, which fills every key explicitly.
 */
export function isPhoneTelemetry(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.type !== PHONE_TELEMETRY) return false;
  const numOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
  return numOrNull(msg.heading) && numOrNull(msg.headingAccuracyDeg)
    && numOrNull(msg.pitch) && numOrNull(msg.roll)
    && numOrNull(msg.lat) && numOrNull(msg.lng)
    && numOrNull(msg.accuracyM) && numOrNull(msg.altitudeM)
    && typeof msg.at === 'string'
    && (msg.deviceLabel === null || typeof msg.deviceLabel === 'string');
}

/** Fill a partial sample out to the full shape, so consumers never branch on missing keys. */
export function normalizePhoneTelemetry(partial, at = new Date().toISOString()) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    type: PHONE_TELEMETRY,
    heading: n(partial?.heading),
    headingAccuracyDeg: n(partial?.headingAccuracyDeg),
    pitch: n(partial?.pitch),
    roll: n(partial?.roll),
    lat: n(partial?.lat),
    lng: n(partial?.lng),
    accuracyM: n(partial?.accuracyM),
    altitudeM: n(partial?.altitudeM),
    at: typeof partial?.at === 'string' ? partial.at : at,
    deviceLabel: typeof partial?.deviceLabel === 'string' ? partial.deviceLabel : null,
  };
}
