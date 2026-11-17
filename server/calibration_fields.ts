/**
 * The calibration fields a scan's upload sidecar hands to its `ScanManifest`.
 *
 * `src/export/gltf.ts` (uploadToServer) writes three calibration things into
 * `<scan>.json`: the flat `calibrationMethod` and `calibrationStatus` summaries, and
 * the whole `ScanCalibration` record as `calibration`. `scanManifestFromStored` in
 * `server/main.ts` turns them into the six `ScanManifest.calibration*` / `calibratedAt`
 * fields with `calibrationFromMeta` below, which is built from the readers above it, and, for a
 * two-point scan whose record carries them, the frame generation (`calibrationFrameId`), the check
 * its status rests on (`calibrationCheckedBy`) and the fit's size and disagreement
 * (`calibrationFitPointsUsed`, `calibrationFitRmsM`, `calibrationFitMaxM`). Those five are left off
 * `calibrationFromMeta`'s answer, not nulled, when the record does not have them, so what it says about a
 * sidecar written before they existed is exactly what it said. `calibrationEvidenceFromMeta` is the same
 * five with every one of them a key, `undefined` when absent, for the manifest a world refresh lays over a
 * stored row: see there.
 * Two things read those fields back out of the manifest:
 *   - the World Editor (`addAnchorMarker` in src/viewer/viewer.ts) draws the anchor decal
 *     from the status, and the red "actual" pins from the method and the separation; its
 *     scan list (src/viewer/scan-calibration-chip.ts) prints the tier, the status and the
 *     residual;
 *   - the Companion Memory push (server/memory_push.ts) ships the method and the status in
 *     `spatial_frame` and `mesh_object_frame`.
 *
 * Where each field lives in a sidecar on disk. The tier and the status are read from the
 * flat summaries, as they always were. The four measurements (`separationM`, `residualM`,
 * `toleranceM`, `calibratedAt`) exist only inside the nested `calibration` record, so they
 * are read from there: that works for every scan already on disk, with no new key and no
 * rewrite. Until `calibrationFromMeta` the manifest carried the first of those four and
 * dropped the other three, which left the editor able to say that a scan was two-point and
 * verified and unable to say by how much.
 *
 * Why this is a module of its own and not functions in `main.ts`: the same reason
 * `take_id.ts`, `scan_index.ts` and `world_lock.ts` exist. `main.ts` cannot be imported by a
 * test without running its top-level side effects (hostname resolution, VLM engine load,
 * `Deno.serve`). While these lived there nothing exercised them, and `asCalibrationMethod`
 * stayed at the one-point tier after the two-point and known-distance tiers shipped, so a
 * real server never told the editor that a scan was two-point.
 * tests/unit/deno/calibration_fields.test.ts and tests/unit/deno/scan_manifest_calibration.test.ts
 * pin them now.
 */
import type { ScanManifest } from '../src/world/types.ts'
import type { CheckedBy } from '../src/world/calibration-evidence.ts'
import { isIsoDateTime } from '../src/shared/iso-time.ts'
import { MAX_FIT_POINTS, MIN_FIT_POINTS } from '../src/world/calibration-evidence.ts'
import { asScaleKind, asScaleMode } from '../src/world/scale-mode.ts'
import { isFrameId } from '../src/world/spatial-frame.ts'

/** A number the record holds under `key`, when it is a finite one. */
function finiteField(record: unknown, key: string): number | null {
  const value = (record as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The measured separation on a stored `ScanCalibration`, when it has one. */
export function asCalibrationSeparationM(value: unknown): number | null {
  return finiteField(value, 'separationM')
}

/**
 * The two-point residual on a stored `ScanCalibration`: the re-measured separation minus the
 * Place's stored one, in metres (0 on a Place's first calibration, where nothing was compared).
 * The known-distance tier carries its own `residualM` (the fit's RMS disagreement). The
 * one-point tier has none.
 */
export function asCalibrationResidualM(value: unknown): number | null {
  return finiteField(value, 'residualM')
}

/** The tolerance the residual was judged against, in metres, when the record carries one. */
export function asCalibrationToleranceM(value: unknown): number | null {
  return finiteField(value, 'toleranceM')
}

/**
 * When the calibration was made: the record's own time, when it is an ISO 8601 date-time as
 * `toISOString` writes it (`ScanCalibration.calibratedAt`). A string that only happens to parse is
 * not that: V8 reads "1" as the year 2001, and another engine reads it differently.
 */
export function asCalibratedAt(value: unknown): string | null {
  const at = (value as { calibratedAt?: unknown } | null | undefined)?.calibratedAt
  return isIsoDateTime(at) ? at : null
}

/**
 * The frame generation a stored two-point calibration was measured against: the record's `frameId`, when it is
 * one (`isFrameId` in src/world/spatial-frame.ts: the format an id is minted in and is safe to put in a path).
 * A missing key, a number, or text that cannot be an id is `undefined`: an unknown generation, which the editor
 * reads as neutral and never as a different frame.
 */
export function asCalibrationFrameId(value: unknown): string | undefined {
  const id = (value as { frameId?: unknown } | null | undefined)?.frameId
  return isFrameId(id) ? id : undefined
}

/**
 * How many points the stored calibration's fit used: a whole number from `MIN_FIT_POINTS` to `MAX_FIT_POINTS`
 * (src/world/frame-fit.ts), the sizes a fit of a Place's points can have. Anything else is `undefined`, and with
 * it the fit's figures are not read (`asCalibrationFitRmsM`, `asCalibrationFitMaxM`). A fit of one or two points
 * is exact and measures nothing (ADR 0005 rule 3: `frame-fit.ts` refuses to make one, and the type says a record
 * has none): the rms of 0 it would carry reads as a measurement, so it is not passed on as one. A count past the
 * most a fit accepts is not a count of points.
 */
export function asCalibrationFitPointsUsed(value: unknown): number | undefined {
  const fit = (value as { fit?: unknown } | null | undefined)?.fit
  const n = finiteField(fit, 'pointsUsed')
  return n !== null && Number.isInteger(n) && n >= MIN_FIT_POINTS && n <= MAX_FIT_POINTS ? n : undefined
}

/** A figure of the stored calibration's fit, when the fit measured something and the figure is a magnitude. */
function fitMagnitude(value: unknown, key: 'rmsResidualM' | 'maxResidualM'): number | undefined {
  if (asCalibrationFitPointsUsed(value) === undefined) return undefined
  const n = finiteField((value as { fit?: unknown }).fit, key)
  return n !== null && n >= 0 ? n : undefined
}

/** The fit's root-mean-square horizontal disagreement, metres. A magnitude: below zero is not one. */
export function asCalibrationFitRmsM(value: unknown): number | undefined {
  return fitMagnitude(value, 'rmsResidualM')
}

/** The fit's largest horizontal disagreement, metres. A magnitude: below zero is not one. */
export function asCalibrationFitMaxM(value: unknown): number | undefined {
  return fitMagnitude(value, 'maxResidualM')
}

/**
 * Which check a stored two-point calibration's status rests on, when the record names one of the two there are.
 * `'constellation'` says three or more points were compared with the Place's and that a fit backs it
 * (`ScanCalibration.checkedBy`): a record that says so without a fit that measured something
 * (`asCalibrationFitPointsUsed`) is a claim nothing supports (ADR 0005 rule 3), and reads as not saying.
 */
export function asCalibrationCheckedBy(value: unknown): CheckedBy | undefined {
  const by = (value as { checkedBy?: unknown } | null | undefined)?.checkedBy
  if (by === 'separation') return by
  return by === 'constellation' && asCalibrationFitPointsUsed(value) !== undefined ? by : undefined
}

/**
 * The calibration tier a sidecar names, when it names one of the tiers there are.
 *
 * Every member of `ScanCalibration['method']` passes through: `'two-point-ground'`,
 * `'ground-tap-compass'` and `'known-distance'`. `src/export/gltf.ts` writes
 * `scanEntry.calibration.method` into this key, whatever it is. The capture client sets the
 * first two; `'known-distance'` is the server's own tier (server/capture/known_distance.ts),
 * which the splat-align job persists into the nested `calibration` record only, so it
 * reaches this key if a writer starts putting it there. It is on the list because it is in
 * the union: this reader is not the place to decide that a tier the manifest type allows may
 * not be named. Anything else is `undefined`, which leaves the field off the manifest: an
 * unknown string, the `null` gltf.ts writes for a scan with no calibration, a value that is
 * not a string at all.
 *
 * Keep this list equal to that union. A tier added to the union stops the exhaustive tables
 * in tests/unit/deno/calibration_fields.test.ts compiling until they list it, and those
 * tests then fail until it is listed here.
 *
 * What the tier changes downstream, so that a widening here is not made lightly: it is the
 * viewer's gate for the red pins (`'two-point-ground'` only), and in server/memory_push.ts it
 * is the condition for shipping `spatial_frame` and the value of
 * `mesh_object_frame.calibration_method` (pinned in tests/unit/deno/memory_push.test.ts).
 */
export function asCalibrationMethod(value: unknown): ScanManifest['calibrationMethod'] {
  return value === 'two-point-ground' || value === 'ground-tap-compass' || value === 'known-distance'
    ? value
    : undefined
}

export function asCalibrationStatus(value: unknown): ScanManifest['calibrationStatus'] {
  return value === 'verified' || value === 'provisional' || value === 'uncalibrated' ? value : undefined
}

/**
 * The `ScanManifest` fields `calibrationFromMeta` fills. The first six are always there; the last five are there
 * only when the record has them.
 */
export type ManifestCalibrationFields = Pick<
  ScanManifest,
  | 'calibrationMethod'
  | 'calibrationStatus'
  | 'calibrationSeparationM'
  | 'calibrationResidualM'
  | 'calibrationToleranceM'
  | 'calibratedAt'
  | 'calibrationFrameId'
  | 'calibrationCheckedBy'
  | 'calibrationFitPointsUsed'
  | 'calibrationFitRmsM'
  | 'calibrationFitMaxM'
>

/**
 * The nested `calibration` record, when it is the record the flat summaries describe.
 *
 * The flat `calibrationMethod` and `projectTransform` are written once, at upload, from one
 * `ScanCalibration`, and the scan is placed by that `projectTransform`. The nested record is
 * written there too, but the `splat-align` job overwrites it with a `'known-distance'`
 * record (`_runSplatAlignJob` in server/main.ts) and leaves the flat keys alone. After that
 * the nested record describes a different frame (camera-solve coordinates, a different
 * separation, a fit's residual) from the one the scan is placed in, and printing its
 * residual under the flat tier's name would be a measurement attached to the wrong claim.
 *
 * So a record that names a tier of its own which is not the tier the summary reports is
 * left out. A record that names no recognised tier cannot be shown to be another one and is
 * read as it always was.
 */
function recordBackingTier(record: unknown, tier: ScanManifest['calibrationMethod']): unknown {
  const own = asCalibrationMethod((record as { method?: unknown } | null | undefined)?.method)
  return own !== undefined && own !== tier ? undefined : record
}

/**
 * Everything a stored scan's sidecar says about its calibration, as `ScanManifest` fields.
 *
 *   - `calibrationMethod`, `calibrationStatus`: the flat summaries `src/export/gltf.ts`
 *     writes (`calibrationMethod`, `calibrationStatus`). Absent when the scan never
 *     calibrated, which writes `null` and `'uncalibrated'`.
 *   - `calibrationSeparationM`, `calibrationResidualM`, `calibrationToleranceM`,
 *     `calibratedAt`: the nested `calibration` record, when it describes the same tier.
 *     `null` when the record is missing, is another tier's, or does not carry the number
 *     (the one-point tier has no separation, residual or tolerance).
 *   - `calibrationFrameId`, `calibrationCheckedBy`, `calibrationFitPointsUsed`, `calibrationFitRmsM`,
 *     `calibrationFitMaxM`: only for a scan whose summary says two-point, because only that member has
 *     a frame generation, a check or a fit (ADR 0005 rule 3: a one-point record never carries a fit, so a
 *     one-point record that claims one is not read). The check and the fit are read from the nested
 *     record, when it describes the same tier, like the measurements above. The frame generation is read
 *     from a flat `calibrationFrameId` key first and from the record second: it names the frame the scan
 *     was placed by, as the flat tier does, and the `splat-align` job replaces the nested record
 *     (see `recordBackingTier`). No sidecar carries the flat key until a writer stamps it, so today
 *     the record is what answers. Each of the five is left off when it is absent or not what its type
 *     says, never set to null. The check and the fit are held together: the fit's figures are read only
 *     when it is a fit of `MIN_FIT_POINTS` or more, and `'constellation'` only when such a fit backs it
 *     (`asCalibrationCheckedBy`), so the manifest never says a measurement was made that the record
 *     does not hold. A refresh that must also CLEAR what an earlier read put on a row wants the five
 *     as keys: that is `calibrationEvidenceFromMeta`.
 *
 * Nothing is derived. A residual is what the record says it was: this does not recompute it
 * from the separation, and does not fill a figure in for a record that has none, because a
 * number the capture never measured would read as a measurement.
 *
 * `scan.meta` is untyped JSON: a sidecar can be hand-edited, truncated or written by an
 * older build, and every field is read defensively and left out when it is not what the
 * type says. That is why a sidecar written before this function existed keeps loading: it
 * carries all of this already, in the record it has always carried.
 */
export function calibrationFromMeta(meta: Record<string, unknown>): ManifestCalibrationFields {
  const method = asCalibrationMethod(meta['calibrationMethod'])
  const record = recordBackingTier(meta['calibration'], method)
  return {
    calibrationMethod: method,
    calibrationStatus: asCalibrationStatus(meta['calibrationStatus']),
    calibrationSeparationM: asCalibrationSeparationM(record),
    calibrationResidualM: asCalibrationResidualM(record),
    calibrationToleranceM: asCalibrationToleranceM(record),
    calibratedAt: asCalibratedAt(record),
    ...(method === 'two-point-ground' ? twoPointEvidenceFromMeta(meta, record) : {}),
  }
}

/** The five `ScanManifest` fields that come from a two-point record's evidence (its frame generation, check and fit). */
type CalibrationEvidenceKey =
  | 'calibrationFrameId'
  | 'calibrationCheckedBy'
  | 'calibrationFitPointsUsed'
  | 'calibrationFitRmsM'
  | 'calibrationFitMaxM'

/** Those five with every one of them a key, `undefined` where the sidecar has no value. */
export type CalibrationEvidenceFields = { [K in CalibrationEvidenceKey]: ScanManifest[K] }

/**
 * The five evidence fields of a stored scan's sidecar, each one always a KEY of the answer: its value when the sidecar
 * holds it (the value `calibrationFromMeta` reads) and `undefined` when it does not.
 *
 * `calibrationFromMeta` leaves an absent field off, and that is not enough for a row that has been read before.
 * `refreshWorldScans` (server/main.ts) lays the manifest it builds from the sidecar over the row the world file stored
 * (`{ ...scan, ...next }`), so a key the new manifest lacks leaves the old row's value standing for good. The
 * measurements `calibrationFromMeta` always sets are cleared that way (`null` when the record has none). These five are
 * not set to `null`: that would say something, and give every manifest from an older sidecar five new keys. A key that
 * is `undefined` clears the row's value and is then no key at all, in the JSON the editor receives and in the world
 * file, as `rejectedTransformField` (server/world/patch_validate.ts) does for the same reason. Without it, when the
 * `splat-align` job replaces the nested record with a known-distance one and leaves the flat summaries alone, the row
 * would go on saying the scan was checked by a fit that its sidecar no longer holds, beside a residual that had been
 * cleared.
 *
 * The frame id can survive such a job: it is read from the flat `calibrationFrameId` key first, and that key is the
 * job's to leave alone.
 */
export function calibrationEvidenceFromMeta(meta: Record<string, unknown>): CalibrationEvidenceFields {
  const fields = calibrationFromMeta(meta)
  return {
    calibrationFrameId: fields.calibrationFrameId,
    calibrationCheckedBy: fields.calibrationCheckedBy,
    calibrationFitPointsUsed: fields.calibrationFitPointsUsed,
    calibrationFitRmsM: fields.calibrationFitRmsM,
    calibrationFitMaxM: fields.calibrationFitMaxM,
  }
}

/**
 * The manifest fields only a two-point record has, each present only when the sidecar holds it. `record` is
 * the nested calibration `recordBackingTier` let through.
 */
function twoPointEvidenceFromMeta(meta: Record<string, unknown>, record: unknown): Partial<CalibrationEvidenceFields> {
  const flatFrameId = isFrameId(meta['calibrationFrameId']) ? meta['calibrationFrameId'] : undefined
  const frameId = flatFrameId ?? asCalibrationFrameId(record)
  const checkedBy = asCalibrationCheckedBy(record)
  const pointsUsed = asCalibrationFitPointsUsed(record)
  const rmsM = asCalibrationFitRmsM(record)
  const maxM = asCalibrationFitMaxM(record)
  return {
    ...(frameId === undefined ? {} : { calibrationFrameId: frameId }),
    ...(checkedBy === undefined ? {} : { calibrationCheckedBy: checkedBy }),
    ...(pointsUsed === undefined ? {} : { calibrationFitPointsUsed: pointsUsed }),
    ...(rmsM === undefined ? {} : { calibrationFitRmsM: rmsM }),
    ...(maxM === undefined ? {} : { calibrationFitMaxM: maxM }),
  }
}

/**
 * The unit a stored scan's AR session ran in, as the manifest fields `scaleMode` (which engine
 * configuration produced it) and `scaleKind` (what it is worth).
 *
 * `src/export/gltf.ts` writes both flat, beside `calibrationStatus`, and inside the whole `calibration`
 * record. The flat key is read first, and the record is the fallback, so a sidecar that only has the
 * record (a hand-edited one, or one a later job rewrote) still reports its unit.
 *
 * Only a value that is one of the known strings comes through. A scan with no valid value for a field
 * gets no key for it: that is every scan uploaded before units were recorded, and a manifest built from
 * one must stay exactly as it was. The two fields are read independently and are not reconciled with each
 * other: this reports what is stored.
 *
 * A scan the scanner never calibrated has no unit to report either. The sidecar this build writes for
 * one says `null` in both flat keys and an older sidecar has no key at all; the manifest does not tell
 * those two apart, and both come out with no key.
 */
export function calibrationScaleFromMeta(meta: Record<string, unknown>): Pick<ScanManifest, 'scaleMode' | 'scaleKind'> {
  const record = meta['calibration']
  const nested = record !== null && typeof record === 'object' ? (record as Record<string, unknown>) : undefined
  const scaleMode = asScaleMode(meta['scaleMode']) ?? asScaleMode(nested?.['scaleMode'])
  const scaleKind = asScaleKind(meta['scaleKind']) ?? asScaleKind(nested?.['scaleKind'])
  return {
    ...(scaleMode === undefined ? {} : { scaleMode }),
    ...(scaleKind === undefined ? {} : { scaleKind }),
  }
}
