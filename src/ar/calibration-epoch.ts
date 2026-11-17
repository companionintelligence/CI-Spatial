/**
 * The frame epoch a calibration flow begins in, as the field its result carries (`CalibrationResult.calibrationEpoch`,
 * ./project-calibration.ts).
 *
 * A scan is calibrated in the epoch the provider was in as the flow began, not the one it was in at the commit: a
 * discontinuity while the person was placing the two points leaves them in two frames, and the calibration is then
 * made in the first of them, so the shift counts against it (the same rule `ScanFrameEpochLog.noteCalibrated` keeps,
 * ./frame-epoch.ts). The host that runs the flow notes the number in the log, and the re-anchor flow
 * (./reanchor-flow.ts) watches for the provider moving past it.
 *
 * A provider with no epoch signal has no epoch to report, and the result carries no field: absent, never 0, because 0
 * is an epoch the runtime really can be in, and a record that says "calibrated in epoch 0" is making a claim about a
 * runtime that never said so.
 *
 * Its own file, so the calibration shell takes it as one line and stays what it was.
 */
import { epochOf, type FrameEpochSource } from './frame-epoch.ts'

export function calibrationEpochField(source: FrameEpochSource | null | undefined): { calibrationEpoch?: number } {
  return typeof source?.getFrameEpoch === 'function' ? { calibrationEpoch: epochOf(source) } : {}
}
