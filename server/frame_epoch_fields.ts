/**
 * What a stored scan's sidecar says about the frames it was recorded in, as the `ScanQualitySummary` fields the editor
 * reads (WP-09b).
 *
 * `src/export/gltf.ts` writes two things into `<scan>.json` that bear on it: the quality summary the phone made, which
 * carries `frameShifts` (how many times the runtime's frame was interrupted or reported moved while the scan was
 * recorded), and `frameEpochs`, the record of which stretches of tracking the point cloud holds points from, whose
 * `mixedEpochs` says whether it holds more than one (src/ar/frame-epoch.ts). `qualitySummaryFromMeta` in
 * `server/main.ts` rebuilt the summary field by field and dropped both, so the editor could not say that a scan's
 * tracking was interrupted. It now adds what this returns, which is what the scan list's "Tracking interrupted N
 * times" line reads (src/viewer/scan-calibration-chip.ts).
 *
 * Nothing is derived and nothing is filled in. A field the sidecar does not hold is left out, never written as 0 or
 * false: a sidecar from before frame epochs were recorded says nothing about whether tracking was interrupted, and "no
 * shifts" would be a claim about a scan nobody counted. `scan.meta` is untyped JSON, so each value is read defensively
 * and left out when it is not what the type says.
 *
 * Why this is a module of its own and not lines in `main.ts`: the same reason `calibration_fields.ts` is. `main.ts`
 * cannot be imported by a test without running its top-level side effects, so the reading is tested here
 * (tests/unit/deno/frame_epoch_fields.test.ts) and a source-shape test holds `main.ts` to calling it.
 */
import type { ScanQualitySummary } from '../src/world/types.ts'

/** The `ScanQualitySummary` fields `frameEpochFieldsFromMeta` fills. */
export type FrameEpochFields = Pick<ScanQualitySummary, 'frameShifts' | 'mixedEpochs'>

function wholeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * `frameShifts` from the phone's own quality summary in the sidecar, and `mixedEpochs` from its `frameEpochs` record,
 * each only when the sidecar holds a value of the right kind.
 */
export function frameEpochFieldsFromMeta(meta: Record<string, unknown>): FrameEpochFields {
  const fields: FrameEpochFields = {}
  const shifts = wholeCount(recordOf(meta['qualitySummary'])?.['frameShifts'])
  if (shifts !== null) fields.frameShifts = shifts
  const mixed = recordOf(meta['frameEpochs'])?.['mixedEpochs']
  if (typeof mixed === 'boolean') fields.mixedEpochs = mixed
  return fields
}
