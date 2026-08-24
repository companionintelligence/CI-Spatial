/**
 * The calibration floor gate — is a tapped point plausibly on the tracked
 * ground plane? (Wave 09 ticket 0003.)
 *
 * Its own module rather than a private helper inside project-calibration.ts
 * because that file references `TouchEvent`, `PointerEvent` and
 * `HTMLCanvasElement`; importing it into a Deno test drags DOM lib types in
 * and fails type-checking (ADR 0002). Keeping the decision pure and separate
 * is what makes the threshold testable at all — and this threshold is the one
 * most likely to need retuning against real device data.
 */

/**
 * How far a tap may sit from the tracked floor before it is questioned.
 *
 * Comfortably clears a real floor tap including carpet, floor slope and
 * hit-test noise; comfortably rejects a tabletop (~0.75 m) or a chair seat
 * (~0.45 m).
 *
 * **A placeholder pending measurement.** The room-loop benchmark
 * (`docs/DEVICE_TESTING.md`) is what sets this. Note the margin to a chair
 * seat is not large, so a worse-than-assumed hit-test noise figure narrows the
 * usable window quickly — which is why the caller offers an override rather
 * than treating a rejection as final.
 */
export const GROUND_TAP_TOLERANCE_M = 0.25

/**
 * Whether `tapY` is consistent with a floor at `groundY`, both in the AR
 * session's local metres.
 *
 * `groundY === null` (no estimate yet) returns `true`: the gate has no opinion
 * where it has no data, and must never block calibration in a room too
 * feature-poor to map a floor.
 */
export function isTapOnGround(tapY: number, groundY: number | null): boolean {
  if (groundY === null) return true
  return Math.abs(tapY - groundY) <= GROUND_TAP_TOLERANCE_M
}

/** Height above (positive) or below the floor estimate, in centimetres, for UI copy. */
export function tapHeightAboveGroundCm(tapY: number, groundY: number): number {
  return Math.round((tapY - groundY) * 100)
}
