/**
 * What the editor's scan list says about how a scan was calibrated.
 *
 * Pure, and kept out of viewer.ts, so the words can be tested without a DOM and each claim sits
 * beside the reason it is true. Same style as src/ar/alignment-status.ts, the scanner's own
 * line for the same result: short plain words, and nothing the data does not hold.
 *
 * ## What the list said before
 *
 * "accuracy 4.0m" (the phone's GPS accuracy) or "manual align", for every scan, including one
 * placed by a calibration that GPS had nothing to do with. Nothing in the editor said the
 * tier, the status or by how much the check agreed. `calibrationStatus` was read in one place,
 * to decide whether to draw a decal.
 *
 * ## What each tier's status proves, and so what the chip may say
 *
 * Two-point, `'verified'` with `checkedBy: 'constellation'` (WP-04b): three or more points tapped in that
 * session were fitted to the Place's stored ones, and their positions, which way they face and their heights
 * agreed inside the limits (`calibrationFitPointsUsed`, `calibrationFitRmsM`: how many points and how far off on
 * average, the figure the scanner's own line quotes in the verdict's words). What a comparison of taps cannot see
 * is named beside it: that these are the same physical spots. On a scan whose phone's units were not metres (`scaleKind`
 * 'arbitrary' or 'estimated-metric') the chip's line and its title also say that sizes in metres were not checked
 * (`unitsLimit`, src/world/frame-fit.ts), because the centimetres it quotes are that phone's.
 *
 * Two-point, `'verified'` with no `checkedBy` (a record from before it existed): exactly one thing. The spacing
 * of the two points tapped in that session (the distance between them) was within the tolerance of the spacing of
 * the Place's stored pair (`residualM` is the re-measured separation minus the stored one). Nothing compares
 * direction or position: the right pair in the other order, or a different pair somewhere else at
 * the same spacing, passes as well. So the chip names the quantity ("spacing 4 cm off", as the
 * scanner's own line names how far apart the points are, because a bare "4 cm off" reads as the
 * tapped points landing within 4 cm of the stored ones, which nothing measures) and says that
 * direction and position were not checked. A "verified" with no residual to show is not a match to
 * tick: it says the frame was set and that nothing about the pair was checked.
 *
 * Two-point, `'provisional'`: the frame is set. With `checkedBy: 'separation'` it was compared with the Place's
 * stored pair by their spacing and nothing else (a visit that tapped two points is never better than this); with
 * `checkedBy: 'constellation'` the points agreed but the check could not be relied on. With neither it was not
 * compared with an earlier pair (a first calibration has a residual of 0 because there was nothing to compare), unless
 * the person kept points that failed the check ("Use anyway"), which leaves a residual beyond the tolerance, a fit
 * beyond its gates (`residualsPastGates`), or points that could not be fitted at all (`keptUnfittedPoints`: checked by a
 * constellation, provisional, and no fit: a mirrored check point, the pair in the other order). That gets a warning, because
 * earlier scans were made against the frame it replaced.
 *
 * One-point: a single tap and the compass. There is nothing to check it against, and records
 * written before the two-point tier carried `'verified'` without any check behind it, so the
 * chip never repeats that word for this tier.
 *
 * Known distance: sized from a distance somebody measured. It sets size and not heading, and
 * the chip prints no figure for it: its `residualM` is the spread of one of two different things
 * (the measured distances against each other, or the frames of one spot against that spot), and
 * the manifest does not say which. No writer puts this tier in the sidecar's flat summary, which is
 * where the manifest takes the tier from (`splat-align` writes it into the nested record only, and
 * `calibrationFromMeta` leaves that out), so today no scan list reaches this branch. It is here
 * because the tier is in the type and this function is total over the type.
 *
 * ## A scan in another frame
 *
 * A scan whose tier differs from the tier the Place's stored frame was made with was not
 * aligned the same way as the scans the frame came from: a one-point frame differs from a
 * two-point one by the bearing of the baseline. The chip names that, and only that: the data
 * says the tiers differ, not by how much.
 *
 * ## Tracking interrupted
 *
 * Whether the runtime's frame was interrupted while the scan was recorded is a separate fact from how it was
 * calibrated, and it applies to a scan that was never calibrated as well, so its line is written for every scan
 * that has it, beside the calibration chip or the GPS text. `qualitySummary.frameShifts` counts the times the runtime
 * lost tracking and got it back after a relocalization or a long loss, was resumed, reported that its origin moved, or
 * stepped farther than a hand can (src/ar/frame-epoch.ts). Each is at least suspect and none is a measurement of how far
 * anything moved, so the line says how many times and the explanation says that it does not say how far. A scan that
 * was ended at the interruption (re-anchored, src/ar/reanchor-flow.ts) holds nothing from after it and carries no count.
 * `qualitySummary.mixedEpochs` says the point cloud holds points from more than one stretch of tracking: "may not line
 * up", because it does not say the stretches disagree. A scan from before either was recorded has neither, and the
 * editor says nothing: not "no interruptions".
 *
 * ## Numbers that do not exist
 *
 * A residual or tolerance that is absent or not finite (a sidecar from an older build, a
 * hand-edited one) prints no figure, never "NaN cm off". A count that is not a whole number of at least one prints no
 * line.
 */
import { isIsoDateTime } from '../shared/iso-time.ts'
import { NOT_CHECKED_SPOTS, formatCm, keptUnfittedPoints, residualsPastGates, unitsLimit } from '../world/frame-fit.ts'
import type { ProjectSpatialFrame, ScanManifest } from '../world/types'

/** The calibration fields of a `ScanManifest` the chip reads. */
export type ChipScan = Pick<
  ScanManifest,
  | 'calibrationMethod'
  | 'calibrationStatus'
  | 'calibrationResidualM'
  | 'calibrationToleranceM'
  | 'calibratedAt'
  | 'qualitySummary'
> & Partial<Pick<ScanManifest, 'calibrationCheckedBy' | 'calibrationFitPointsUsed' | 'calibrationFitRmsM' | 'calibrationFitMaxM' | 'scaleKind'>>

export interface ScanCalibrationChip {
  /** Takes the place of the GPS accuracy text on the scan's meta line. */
  text: string
  /** A second visible line, for what the status does not prove. Null when there is nothing to add. */
  note: string | null
  /** A visible line when the scan was calibrated a different way from the Place's frame. Null otherwise. */
  frameWarning: string | null
  /** The longer explanation, for hover and for assistive technology. */
  title: string
  /** `'warn'` when a calibration was kept past a failed check. */
  tone: 'plain' | 'warn'
}

type Tier = NonNullable<ScanManifest['calibrationMethod']>

const TIER_LABEL: Record<Tier, string> = {
  'two-point-ground': 'two-point',
  'ground-tap-compass': 'one-point',
  'known-distance': 'known distance',
}

/**
 * Whole centimetres, unsigned, as the scanner's own line reports them. Null for a number that does not exist,
 * which includes a finite one too large to convert: 1e308 metres times 100 is Infinity, and prints as such.
 */
function centimetres(metres: number | null | undefined): string | null {
  if (typeof metres !== 'number') return null
  const cm = Math.abs(metres * 100)
  return Number.isFinite(cm) ? cm.toFixed(0) : null
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** `2026-11-01 10:00 UTC`: fixed, so the same record reads the same everywhere. Null when the time is not an ISO date-time. */
function calibratedLine(calibratedAt: string | null | undefined): string | null {
  if (!isIsoDateTime(calibratedAt)) return null
  return `Calibrated ${new Date(calibratedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
}

/**
 * The warning for a scan whose tier is not the tier of the Place's stored frame. A frame made with a method this
 * editor has no name for (a Place file from a newer build, or one written by hand) is still a different frame, and
 * is called that: never "the undefined method".
 */
function frameWarningFor(
  method: Tier,
  placeMethod: ProjectSpatialFrame['method'] | null | undefined,
): { line: string; title: string } | null {
  if (typeof placeMethod !== 'string' || placeMethod.length === 0 || placeMethod === method) return null
  const placeTier = Object.hasOwn(TIER_LABEL, placeMethod)
    ? `the ${TIER_LABEL[placeMethod as Tier]} method`
    : 'a method this editor does not know'
  return {
    line: 'Different frame from this Place',
    title: `This scan was calibrated with the ${TIER_LABEL[method]} method and this Place's frame was made with ${placeTier}. Scans in different frames may not line up.`,
  }
}

/**
 * The chip for a two-point scan that was checked by a fit of three or more points, or `null` for any other scan: one with
 * no check named, one checked by spacing, or a record that names a fit and carries no figure for it (read as any other),
 * unless it is the comparison that could not be fitted at all and was kept (`keptUnfittedPoints`), which is a warning.
 */
function fittedChip(
  scan: ChipScan,
  tier: string,
  chip: (parts: string[], note: string | null, explanation: string, tone?: ScanCalibrationChip['tone']) => ScanCalibrationChip,
): ScanCalibrationChip | null {
  const points = scan.calibrationFitPointsUsed
  const rms = finiteOrNull(scan.calibrationFitRmsM)
  const hasFit = points !== undefined || scan.calibrationFitRmsM !== undefined
  if (keptUnfittedPoints(scan.calibrationCheckedBy, scan.calibrationStatus, hasFit)) {
    return chip(
      [tier, 'provisional', 'points did not match'],
      'Kept after a mismatch; earlier scans may not line up',
      `Frame set from floor points that did not match this Place's stored ones, and were kept. Earlier scans were made against the frame it replaced.`,
      'warn',
    )
  }
  if (scan.calibrationCheckedBy !== 'constellation' || points === undefined || rms === null) return null
  const off = formatCm(rms)
  const quoted = `${points} points ${off} cm off`
  // The centimetres are the phone's units, which are not metres on every phone: the figure is then not the same as a figure in
  // metres, and the card the person saw at the time said so. The chip's own line and its title say so too.
  const units = unitsLimit(scan.scaleKind)
  const sizes = units === null ? '' : ` ${units}`
  if (scan.calibrationStatus === 'verified') {
    return chip(
      [tier, 'verified', quoted],
      units === null ? 'Same physical spots not checked' : 'Same physical spots and sizes in metres not checked',
      `Frame set from ${points} floor points fitted to this Place's stored ones: ${off} cm off on average. Their positions, which way they face and their heights were compared. ${NOT_CHECKED_SPOTS}${sizes}`,
    )
  }
  const max = finiteOrNull(scan.calibrationFitMaxM) ?? rms
  const tolerance = finiteOrNull(scan.calibrationToleranceM)
  if (tolerance !== null && residualsPastGates(rms, max, tolerance)) {
    return chip(
      [tier, 'provisional', quoted],
      'Kept after a mismatch; earlier scans may not line up',
      `Frame set from ${points} floor points that were ${off} cm off this Place's stored ones on average, past the limit, and were kept. Earlier scans were made against the frame it replaced.${sizes}`,
      'warn',
    )
  }
  return chip(
    [tier, 'provisional', quoted],
    'Not verified: the check could not be relied on',
    `Frame set from ${points} floor points fitted to this Place's stored ones: ${off} cm off on average, inside the limits, but the check could not be relied on.${sizes}`,
  )
}

/**
 * The chip for one scan, or `null` for a scan that carries no calibration (the caller keeps the
 * GPS text it always had). `placeMethod` is the tier of the Place's stored frame, when it has one.
 */
export function scanCalibrationChip(
  scan: ChipScan,
  placeMethod?: ProjectSpatialFrame['method'] | null,
): ScanCalibrationChip | null {
  const method = scan.calibrationMethod
  const status = scan.calibrationStatus
  if (!method || status === 'uncalibrated') return null

  const tier = TIER_LABEL[method]
  const off = centimetres(scan.calibrationResidualM)
  const toleranceCm = centimetres(scan.calibrationToleranceM)
  // A figure that cannot be printed does not exist for any purpose below, so no branch is taken on a number
  // it then has no words for.
  const residual = off === null ? null : finiteOrNull(scan.calibrationResidualM)
  const tolerance = toleranceCm === null ? null : finiteOrNull(scan.calibrationToleranceM)
  const when = calibratedLine(scan.calibratedAt)
  const warning = frameWarningFor(method, placeMethod)

  const chip = (
    parts: string[],
    note: string | null,
    explanation: string,
    tone: ScanCalibrationChip['tone'] = 'plain',
  ): ScanCalibrationChip => ({
    text: parts.join(' · '),
    note,
    frameWarning: warning?.line ?? null,
    title: [explanation, when, warning?.title].filter((part): part is string => !!part).join(' '),
    tone,
  })

  if (method === 'ground-tap-compass') {
    // 'verified' on this tier predates the checks and means nothing, so the status is not repeated.
    return chip(
      [tier, 'provisional'],
      'Aligns only at the same spot',
      'Frame set from one floor point and the compass heading. It cannot be checked against another visit.',
    )
  }

  if (method === 'known-distance') {
    const word = status === 'verified' || status === 'provisional' ? status : null
    return chip(
      [tier, ...(word ? [word] : [])],
      'Sized from a measured distance; heading not set',
      'Sized from a distance somebody measured between two camera positions. It sets size, not which way the scan faces.',
    )
  }

  // method === 'two-point-ground'
  const fitted = fittedChip(scan, tier, chip)
  if (fitted) return fitted

  if (status === 'verified') {
    // A verified result without a residual compared nothing we can show: the frame is set and that is all.
    if (off === null) {
      return chip(
        [tier, 'frame set'],
        'Spacing, direction and position not checked',
        'Frame set from two floor points. No figure was recorded for how well their spacing matched an earlier pair, and neither their direction nor their position was checked.',
      )
    }
    return chip(
      [tier, 'verified', `spacing ${off} cm off`],
      'Direction and position not checked',
      `Frame set from two floor points. The spacing between them was ${off} cm off the spacing of this Place's stored pair, ${toleranceCm === null ? 'inside the tolerance' : `inside the ${toleranceCm} cm tolerance`}. Neither which way they pointed nor where they were was checked.`,
    )
  }

  if (status === 'provisional') {
    // The comparison commitTwoPoint gates on, strictly: only a pair kept past a failed check lands here.
    if (residual !== null && tolerance !== null && Math.abs(residual) > tolerance) {
      return chip(
        [tier, 'provisional', `spacing ${off} cm off`],
        'Kept after a mismatch; earlier scans may not line up',
        `Frame set from two floor points. The spacing between them was ${off} cm off the spacing of this Place's stored pair, past the ${toleranceCm} cm tolerance, and it was kept. Earlier scans were made against the pair it replaced.`,
        'warn',
      )
    }
    // Two points were compared by their spacing and nothing else: the figure is shown, and what was not compared is named.
    if (scan.calibrationCheckedBy === 'separation' && off !== null) {
      return chip(
        [tier, 'provisional', `spacing ${off} cm off`],
        'Direction and position not checked',
        `Frame set from two floor points. The spacing between them was ${off} cm off the spacing of this Place's stored pair. Neither which way they pointed nor where they were was checked.`,
      )
    }
    // A figure with no failed check behind it is shown and claimed no further.
    if (residual !== null && residual !== 0) {
      return chip([tier, 'provisional', `spacing ${off} cm off`], null, 'Frame set from two floor points.')
    }
    // A residual of 0 is what a Place's first calibration records: there was nothing to compare it with.
    return chip(
      [tier, 'provisional'],
      'Not compared with an earlier pair',
      'Frame set from two floor points. It was not compared with an earlier pair for this Place.',
    )
  }

  // No status word in the record: the tier is all it gives, and nothing more is claimed.
  return chip([tier], null, 'Frame set from two floor points.')
}

/** What the editor says about a scan's tracking being interrupted, or null for a scan with nothing to say. */
export interface TrackingNote {
  /** "Tracking interrupted 2 times": visible, null when the count is absent or none. */
  line: string | null
  /** "Points from before and after may not line up": visible, null unless the cloud spans more than one stretch. */
  note: string | null
  /** The longer explanation, for hover and for assistive technology. */
  title: string
}

/**
 * The tracking line and note for one scan. The count is read only when it is a whole number of at least one, so a
 * sidecar that holds none, or a nonsense value, says nothing.
 */
export function trackingNote(scan: Pick<ChipScan, 'qualitySummary'>): TrackingNote | null {
  const shifts = scan.qualitySummary?.frameShifts
  const count = typeof shifts === 'number' && Number.isFinite(shifts) && shifts >= 1 ? Math.floor(shifts) : null
  const mixed = scan.qualitySummary?.mixedEpochs === true
  if (count === null && !mixed) return null
  const explanation: string[] = []
  if (count !== null) {
    explanation.push(
      `The AR runtime lost tracking, reported that its origin moved, or was resumed ${count} time${count === 1 ? '' : 's'} while this scan was recorded. Parts of the scan may be shifted against each other. This counts the interruptions: it does not measure how far anything moved.`,
    )
  }
  if (mixed) explanation.push('The point cloud holds points from more than one stretch of tracking.')
  return {
    line: count === null ? null : `Tracking interrupted ${count} time${count === 1 ? '' : 's'}`,
    note: mixed ? 'Points from before and after may not line up' : null,
    title: explanation.join(' '),
  }
}

/**
 * The markup of one scan's meta lines in the editor's scan list: the captured date with, for a
 * calibrated scan, the chip text where the GPS accuracy used to be; what the status does not
 * prove, and the frame warning, each on a line of its own, because a tooltip is not visible on a
 * touch screen and the caveat is not optional. A scan without a calibration keeps the GPS text
 * it always had ("accuracy 4.0m", or "manual align" when it has no fix).
 *
 * `escape` is the viewer's own HTML escape. Every piece of text goes through it, the date label and
 * the GPS text included and the `title` too, because a record that did not come from this build is
 * data and not markup.
 */
export function scanMetaMarkup(
  scan: ChipScan & Pick<ScanManifest, 'accuracyM'>,
  capturedLabel: string,
  placeMethod: ProjectSpatialFrame['method'] | null | undefined,
  escape: (text: string) => string,
): string {
  const chip = scanCalibrationChip(scan, placeMethod)
  const line = (text: string, tone: ScanCalibrationChip['tone'], title?: string): string =>
    `<div class="scan-calibration-note" data-tone="${tone}"${title ? ` title="${escape(title)}"` : ''}>${escape(text)}</div>`
  // Beside the calibration lines, and beside the GPS text of a scan that has none: an interruption is not about calibration.
  const tracking = trackingNote(scan)
  const trackingLines = tracking
    ? [tracking.line ? line(tracking.line, 'warn', tracking.title) : '', tracking.note ? line(tracking.note, 'warn', tracking.title) : '']
    : []
  if (!chip) {
    const accuracy = scan.accuracyM != null ? `accuracy ${scan.accuracyM.toFixed(1)}m` : 'manual align'
    return [`<div class="scan-meta">${escape(capturedLabel)} · ${escape(accuracy)}</div>`, ...trackingLines].join('')
  }
  return [
    `<div class="scan-meta" title="${escape(chip.title)}">${escape(capturedLabel)} · ${escape(chip.text)}</div>`,
    chip.note ? line(chip.note, chip.tone) : '',
    chip.frameWarning ? line(chip.frameWarning, 'warn') : '',
    ...trackingLines,
  ].join('')
}

/**
 * The scan list's meta lines for one scan, as the editor draws them: the capture time as the
 * viewer's own locale writes it ("Unknown date" when the scan has none, or one that does not
 * parse), and then {@link scanMetaMarkup}.
 */
export function scanMetaHtmlFor(
  scan: ChipScan & Pick<ScanManifest, 'accuracyM' | 'capturedAt'>,
  placeMethod: ProjectSpatialFrame['method'] | null | undefined,
  escape: (text: string) => string,
): string {
  const captured = scan.capturedAt ? new Date(scan.capturedAt) : null
  const capturedLabel = captured && !Number.isNaN(captured.getTime())
    ? captured.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Unknown date'
  return scanMetaMarkup(scan, capturedLabel, placeMethod, escape)
}

/**
 * Draws every listed scan's meta lines again. The Place's frame, which they are compared with, can
 * change under an open editor (a scan calibrated on a phone replaces it), and nothing else redraws a
 * row that was built before it did. `blockFor` finds the element a scan's lines live in, or nothing
 * for a scan that has no row.
 */
export function redrawScanMeta(
  scans: readonly (ChipScan & Pick<ScanManifest, 'scanId' | 'accuracyM' | 'capturedAt'>)[],
  blockFor: (scanId: string) => { innerHTML: string } | null | undefined,
  placeMethod: ProjectSpatialFrame['method'] | null | undefined,
  escape: (text: string) => string,
): void {
  for (const scan of scans) {
    const block = blockFor(scan.scanId)
    if (block) block.innerHTML = scanMetaHtmlFor(scan, placeMethod, escape)
  }
}
