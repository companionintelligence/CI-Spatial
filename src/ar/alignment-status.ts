/**
 * What the scanner tells the person once the Place calibration has finished.
 *
 * Pure, and kept out of main.ts, so the copy can be tested without a DOM and so
 * each claim sits next to the reason it is true.
 *
 * ## What `'verified'` proves, and the copy that follows from it
 *
 * On the two-point tier `status: 'verified'` means one of two things, and `checkedBy` says which (WP-04b).
 *
 * `checkedBy: 'constellation'`: three or more points tapped this visit were fitted to the Place's stored ones, and their
 * positions, which way they face and their heights agreed inside the limits with nothing in the way
 * (`verifyFit`, src/world/frame-fit.ts). The copy reports how many points and how far off, in the words the verdict
 * uses, and ends by naming what no check of taps can see: that these are the same physical spots. It does not say the
 * alignment, the frame or the Place was verified, because the points were.
 *
 * No `checkedBy` (a record written before it existed), and on this tier nothing else can reach `'verified'`: the distance
 * between the two points tapped this visit was within `toleranceM` of the distance between the Place's stored pair
 * (`residualM` is the re-measured separation minus the stored one). Nothing compares direction. The right pair tapped in
 * the other order, or a different pair at the same spacing, passes as well. So the copy reports that the two points are
 * about as far apart as stored (a tolerance, not an equality), and says in the same breath that direction was not
 * checked. The headline names the quantity that was compared (how far apart the points are from each other) because a
 * bare "distance matches the stored pair" reads as the tapped points landing within some distance of the stored ones,
 * which nothing measures.
 *
 * A distance check is never `'verified'` any more: a visit that tapped two points, or a Place with no check point, is
 * `'provisional'` with `checkedBy: 'separation'`, and the copy is the frame-fit verdict table's: "Frame set. Distance
 * checked, direction not checked".
 *
 * The centimetres of a fit are the phone's units, which are not metres on every phone (`scaleKind`, stamped on the scan by
 * `stampScale`, src/ar/engine-config.ts, which is why the caller passes the stamped calibration). Where they are not, or the
 * phone only estimates them, the lines that quote a fit's figure end with the verdict's own sentence about sizes in metres
 * (`unitsLimit`, src/world/frame-fit.ts), as the card did beside the same figure.
 *
 * A compass heading check is deliberately not added here to make the claim
 * stronger. docs/audits/2026-11-13-goal-readiness.md (W4-5, F53) parks it: the
 * compass handedness is unsettled and a sign error would mirror east and west,
 * the stored `anchorBearingDeg` is the session +Z bearing and not the pair's,
 * and the tolerance needs a device run.
 *
 * ## The mismatch the person kept
 *
 * When the visit's points are off by more than the limits, the flow offers
 * "Use anyway". `commitTwoPoint(true)` then REPLACES the Place's stored frame
 * with this visit's points (`frameChanged = !storedTwoPoint || override`, and main.ts
 * persists the new `spatialFrame` to the Place), while every earlier scan keeps
 * the calibration it made against the old frame. Scans from before and after may
 * not line up, and nothing on screen would say so if this fell through to the
 * first-calibration line. That result is `'provisional'` and carries the evidence
 * of the check that failed, and it gets its own warning that it was kept as the
 * person chose and that earlier scans may not line up.
 *
 *  - Two points: `|residualM| > toleranceM`, the gap in the pair's spacing (a first
 *    calibration has a residual of 0, so nothing else reaches it). The figure is the
 *    one the mismatch screen reports, rounded the same way.
 *  - Three or more: the fit's residuals are beyond the gates of the tolerance written
 *    beside them (`residualsPastGates`: that tolerance is twice the rms gate), which a
 *    fit that passed but could not be verified is not.
 *  - Three or more that could not be fitted at all, because a check point was on the wrong
 *    side or the pair was taken in the other order (`fitRigid2D` gives a reason and no
 *    figures): the record names the constellation as its check, is provisional and holds
 *    no fit (`keptUnfittedPoints`). It gets the same warning, without a figure, because it is
 *    the likeliest kept mismatch of all: the reversed pair is the failure this check exists
 *    for, and falling through to the first-calibration line would hide it.
 *
 * ## Numbers that do not exist
 *
 * A residual that is not a finite number (a stored frame with no usable
 * separation, a record from before the field existed) prints no figure at all:
 * never "NaN cm off". Nothing was compared, so a 'verified' status with such a
 * residual gets no tick and no match claim either: the frame is set, the spacing
 * was not compared, and direction was not checked. Where there is no residual to
 * compare, no mismatch is claimed.
 *
 * ## How it is written
 *
 * The caller writes it at the `'sticky'` priority (../ui/status-line.ts). The
 * line after it in main.ts writes the tracking prompt in the same synchronous
 * run, and at the default priority that write replaced the outcome before it
 * was ever painted.
 */
import { NOT_CHECKED_SPOTS, formatCm, keptUnfittedPoints, residualsPastGates, unitsLimit } from '../world/frame-fit.ts'
import type { ScanCalibration } from '../world/types'

/** Whole centimetres, unsigned, as the mismatch screen reports them. Null for a number that does not exist. */
function centimetres(metres: number): string | null {
  return Number.isFinite(metres) ? Math.abs(metres * 100).toFixed(0) : null
}

/** The line for points that did not fit at all (a mirrored check point, the pair in the other order) and were kept: no figure exists to quote. */
const KEPT_UNFITTED_TEXT = '⚠ Points did not match the stored ones\n• Kept as you chose; earlier scans may not line up'

/**
 * The line for a record that was checked by a fit of three or more points. `null` when the record has no usable fit to
 * quote, which is then read as any other record, unless it is the comparison that could not be fitted and was kept
 * (`keptUnfittedPoints`): that one never reads as a frame that was merely set.
 */
function constellationText(calibration: Extract<ScanCalibration, { method: 'two-point-ground' }>): string | null {
  const fit = calibration.fit
  if (calibration.checkedBy !== 'constellation') return null
  if (!fit) return keptUnfittedPoints(calibration.checkedBy, calibration.status, false) ? KEPT_UNFITTED_TEXT : null
  if (!Number.isFinite(fit.rmsResidualM) || !Number.isInteger(fit.pointsUsed) || fit.pointsUsed < 3) return null
  const off = formatCm(fit.rmsResidualM)
  // The centimetres are the phone's units, which are not metres on every phone: the card beside this line said so, and so does it.
  const units = unitsLimit(calibration.scaleKind)
  const limit = units === null ? '' : `\n• ${units}`
  if (calibration.status === 'verified') {
    return `✓ ${fit.pointsUsed} points are ${off} cm off the stored ones\n• ${NOT_CHECKED_SPOTS}${limit}`
  }
  if (calibration.status === 'provisional' && residualsPastGates(fit.rmsResidualM, fit.maxResidualM, calibration.toleranceM)) {
    return `⚠ Points are ${off} cm off the stored ones\n• Kept as you chose; earlier scans may not line up${limit}`
  }
  return `Frame set. ${fit.pointsUsed} points are ${off} cm off the stored ones\n• Not verified: the points agreed, but the check could not be relied on${limit}`
}

/** A scan continued without a calibration: no frame, no alignment, and it does not set the Place's frame (#269). */
export const NO_ALIGNMENT_TEXT = '⚠ No project alignment\n• Scanning without it. This scan does not set the Place frame'

/**
 * A commit whose floor check was bypassed ("Place anchor without floor check", or an off-floor tap accepted by a same-height retry):
 * provisional, and it never writes the Place's frame (`mayWritePlaceFrame`, ./ground-gate.ts; the origin decal's wave, #269).
 */
export const FLOOR_CHECK_BYPASSED_TEXT = 'Floor check bypassed — provisional, and this scan does not set the Place frame.'

/**
 * The origin decal draws a north tick when the compass was read, and the tick is where that reading put north in this session. It is
 * not a surveyed north, so the line says so wherever a tick was drawn (#269).
 */
export const NORTH_TICK_NOTE = 'North tick is session-local'

/**
 * The status text for a finished calibration.
 *
 * `null` (or `undefined`) is a calibration the person continued without: the
 * scan still saves, and the server places it by GPS or on a grid.
 */
export function alignmentStatusText(calibration: ScanCalibration | null | undefined): string {
  if (!calibration) return NO_ALIGNMENT_TEXT

  // A bypassed floor check is said first, on either tier and whatever the separation was: it caps the scan at provisional and keeps it
  // from setting the Place frame.
  if (calibration.floorCheckBypassed === true) return FLOOR_CHECK_BYPASSED_TEXT

  // The scanner's own flow returns only the two tiers handled here; anything
  // that is not a two-point frame gets the one-point warning, as it did when
  // this was inline in main.ts.
  if (calibration.method !== 'two-point-ground') {
    return '⚠ Single-point anchor\n• Aligns only at the same spot'
  }

  const text = twoPointStatusText(calibration)
  const tickDrawn = typeof calibration.anchorBearingDeg === 'number' && Number.isFinite(calibration.anchorBearingDeg)
  return tickDrawn ? `${text}\n• ${NORTH_TICK_NOTE}` : text
}

type TwoPointCalibration = Extract<ScanCalibration, { method: 'two-point-ground' }>

/** What a two-point calibration says for itself: the fit's verdict, or the spacing that was compared, or that nothing was. */
function twoPointStatusText(calibration: TwoPointCalibration): string {
  const off = centimetres(calibration.residualM)

  // Three or more points were fitted to the stored ones: the verdict's own words, from the fit the record keeps.
  const fitted = constellationText(calibration)
  if (fitted !== null) return fitted

  // A stored pair existed and the spacing matched it inside the tolerance (a record from before a distance check stopped
  // being verified). "About", because the check is a tolerance and not an equality: next to "14 cm off", "exactly as far
  // apart" would contradict itself.
  if (calibration.status === 'verified') {
    // 'verified' is a measurement, and a measurement that does not exist (no finite residual) is not a match
    // to tick: say the frame is set and that neither spacing nor direction was checked, and claim nothing more.
    if (off === null) return 'Project frame set from two points.\n• Spacing and direction not checked'
    return `✓ Points about as far apart as stored\n• ${off} cm off, direction not checked`
  }

  // The comparison `commitTwoPoint` gates on (`Math.abs(residualM) > toleranceM`, strictly). A first calibration
  // has a residual of 0, so only the "Use anyway" override leaves a provisional result beyond the tolerance. NaN
  // and a missing residual are no comparison at all, so they fail this test and are not called a mismatch.
  if (calibration.status === 'provisional' && Math.abs(calibration.residualM) > calibration.toleranceM) {
    // An unbounded gap is still a gap that failed the check; it is reported without a number.
    return `⚠ Pair spacing is ${off === null ? 'far' : `${off} cm`} off the stored one\n• Kept as you chose; earlier scans may not line up`
  }

  // A visit that tapped two points against a stored pair: the spacing was compared and nothing else (the verdict table's sentence).
  // A spacing that is not a figure compared nothing, and says so, as a verified record with no residual does.
  if (calibration.status === 'provisional' && calibration.checkedBy === 'separation') {
    if (off === null) return 'Project frame set from two points.\n• Spacing and direction not checked'
    return `Frame set. Distance checked, direction not checked\n• ${off} cm off the stored distance`
  }

  // A Place's first calibration, with nothing stored to compare against, and any record that is not a verified or
  // kept-mismatch result: the frame is set, and that is all there is to report.
  return 'Project frame set from two points. Start scanning.'
}
