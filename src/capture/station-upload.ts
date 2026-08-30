/**
 * What a tripod capture adds to an ordinary photo upload.
 *
 * ## The seam this closes
 *
 * The server has the whole tripod path: it refuses a capture taken from a
 * single spot (measured — one spot placed 3 of 17 photos in 3D, and no amount
 * of photos from it changes that), it groups the photos by the spot they came
 * from, and it can size the room from one measured length. Every one of those
 * keys off two things arriving with the photos: which spot each one was taken
 * from, and the measurement.
 *
 * Tripod Scan sent neither. It collected the photos and handed them to the
 * ordinary photo uploader as one flat set, so a capture the app made itself
 * arrived indistinguishable from a bag of holiday snaps — no refusal if it came
 * from one spot, and no way to know how big the room was. Those protections
 * were reachable only by an external gimbal client.
 *
 * ## Why this is three small functions and not an uploader
 *
 * The fix is two extra form fields on the upload that already happens, not a
 * second way to send photos (ADR 0001). `/ingest-photos` takes `stations` —
 * one spot number per file, positionally — and `knownDistances`, and branches
 * to the same finishing code the gimbal client's route uses. So the Place
 * target, the progress percentage, the size guard, the blur filter and the
 * failure messages all stay exactly where they were, and this module only has
 * to produce the two fields.
 *
 * Register note: `station` is wire vocabulary — the form field and the
 * viewpoint id. Nothing here produces a sentence anyone reads.
 */

/**
 * The viewpoint id prefix the server builds from a spot number, and the reason
 * a measurement can name the spots it was taken between: `station-0` is the
 * first spot.
 *
 * A constant rather than an import — the module that consumes it is Deno server
 * code — so the two ends of the wire are one edit apart.
 */
export const VIEWPOINT_PREFIX = 'station-'

/** The id of a spot, 0-based, as a measurement refers to it. */
export function viewpointId(spotIndex: number): string {
  return `${VIEWPOINT_PREFIX}${spotIndex}`
}

/** One photo and the spot the tripod stood on when it was taken (0-based). */
export interface StationFrame {
  file: File
  spot: number
}

/** One tape reading, in the shape the server's sizing step consumes. */
export interface KnownDistance {
  from: string
  to: string
  metres: number
}

/**
 * Flatten per-spot photo lists into the upload order.
 *
 * Position is the whole contract: the server matches `stations[i]` to the i-th
 * file of the upload, so {@link stationsFor} and {@link filesFor} must be built
 * from this one sequence and never assembled separately. Empty spots cannot
 * occur — the state machine refuses a sweep that produced nothing — but they
 * are skipped rather than trusted, because an empty spot would shift every
 * later spot number by one and silently mislabel the whole capture.
 */
export function planStationFrames(spotFiles: readonly (readonly File[])[]): StationFrame[] {
  const frames: StationFrame[] = []
  spotFiles.forEach((files, spot) => {
    for (const file of files) frames.push({ file, spot })
  })
  return frames
}

/** The files, in the order the spot numbers describe. */
export function filesFor(frames: readonly StationFrame[]): File[] {
  return frames.map(frame => frame.file)
}

/** The `stations` field: one whole spot number per file, in the same order. */
export function stationsFor(frames: readonly StationFrame[]): number[] {
  return frames.map(frame => frame.spot)
}

/**
 * The `knownDistances` field.
 *
 * Between the first two spots, because those are the two the operator was asked
 * about. An empty list is the honest representation of a skipped measurement:
 * the capture still goes, and it simply has no size. Nothing here invents a
 * reading — a zero, a NaN or a reference to a spot that was never captured
 * would each be read downstream as a real measured length.
 */
export function knownDistancesFor(
  measurement: { kind: 'measured', fromSpot: number, toSpot: number, metres: number } | { kind: 'skipped' } | null,
  spotCount: number,
): KnownDistance[] {
  if (!measurement || measurement.kind !== 'measured') return []
  const from = measurement.fromSpot - 1
  const to = measurement.toSpot - 1
  if (from < 0 || to < 0 || from >= spotCount || to >= spotCount || from === to) return []
  if (!Number.isFinite(measurement.metres) || measurement.metres <= 0) return []
  return [{ from: viewpointId(from), to: viewpointId(to), metres: measurement.metres }]
}
