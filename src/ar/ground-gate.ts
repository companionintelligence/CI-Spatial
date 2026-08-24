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

/**
 * Signed height relative to the floor estimate, in centimetres, for UI copy.
 * Positive is above the floor, negative below — a below-floor hit is real
 * (a gap in the mesh, a reflective surface, or an over-high estimate) and
 * reporting it as "above" would send the user looking in the wrong direction.
 */
export function tapHeightAboveGroundCm(tapY: number, groundY: number): number {
  return Math.round((tapY - groundY) * 100)
}

/**
 * Whether a retry is at the same height as the tap that was just rejected —
 * the confirmation the off-floor override actually asks for.
 *
 * The override exists so a user whose floor estimate is wrong (thick carpet, a
 * mezzanine, a sunken room) can insist on a height. Honouring *any* second tap
 * would let a rejected tabletop tap be confirmed by a tap on a shelf a metre
 * higher, which is not what the user was asked to confirm and not what they
 * would think they had done.
 *
 * Reuses GROUND_TAP_TOLERANCE_M: "the same height" and "close enough to the
 * floor" are the same order of judgement, and a second constant here would be
 * one more thing to retune with no independent meaning.
 */
export function isSameHeightRetry(tapY: number, rejectedTapY: number | null): boolean {
  if (rejectedTapY === null) return false
  return Math.abs(tapY - rejectedTapY) <= GROUND_TAP_TOLERANCE_M
}
