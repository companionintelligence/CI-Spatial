/**
 * Station-dome capture — the third capture path, beside 8th Wall and WebXR.
 *
 * A gimbal on a tripod sweeps a dome of photos from one fixed spot, the
 * operator carries the tripod to a new spot, and it sweeps again; 3–5 spots
 * ("stations") cover a room. No AR runtime, no SLAM, no ARCore — which is the
 * point: the test phone (XREAL Beam Pro) has no ARCore, so WebXR is dead there,
 * and 8th Wall's SLAM started in roughly two attempts out of eight.
 *
 * ── Why the station index is the one thing this module cares about ──────────
 *
 * Measured on real COLMAP runs, 2026-08-29:
 *
 *   single dome, rotating in place       3 / 17 images registered   DEGENERATE
 *   5 stations x a dome each            36 / 36 images registered   9,914 points
 *   continuous walkthrough              48 / 48 images registered
 *
 * A single dome is pure rotation about the camera: zero translational baseline,
 * so monocular structure-from-motion has nothing to triangulate, no matter how
 * many photos the dome holds. The parallax comes from the tripod MOVING BETWEEN
 * stations. That makes station count — not frame count — the number that
 * decides whether a capture can reconstruct at all, and it is why every frame
 * carries its station index into keyframes.jsonl.
 *
 * ── Where the frames come from (the contract with subsystems/osmo-ble) ──────
 *
 * They arrive over the routes that already exist. The gimbal subsystem opens a
 * capture session with `POST /sessions`, then posts each photo to
 * `POST /sessions/:id/keyframes` with meta `{ index, station, pan, tilt }`.
 * That route already spreads unknown meta keys into keyframes.jsonl verbatim,
 * so `station` needs no transport of its own — this module only has to read it
 * back (ADR 0001: reuse, don't duplicate).
 *
 * The server deliberately does NOT drive the gimbal. Two reasons, both hard:
 * the BLE backend must run as a specific Node binary holding cap_net_raw and
 * lives in its own process, and — decisively — the move BETWEEN stations is a
 * human picking up a tripod and walking. A WorldJob cannot wait on that, and
 * the pump is globally single-flight, so a job that tried would block every
 * other upload for as long as the operator took. Capture is therefore driven
 * from outside and lands here as a finished session, exactly like an uploaded
 * photo set.
 *
 * ── What this module does not know ─────────────────────────────────────────
 *
 * Whether the stations are collinear. Three spots in a straight line share one
 * baseline and reconstruct badly, and the measured-good layout was a rough ring
 * plus a centre point for that reason — but a station-dome capture has no
 * metric pose by definition (that is what COLMAP is being asked to produce), so
 * the server has no positions to test. It is stated in the operator guidance
 * instead of silently assumed.
 */

/** `session.json`'s `source` for a capture built this way. */
export const STATION_DOME_SOURCE = 'station-dome'

/**
 * Two stations is the minimum that CAN work: it is the smallest number that
 * gives any translational baseline at all. It is a floor, not a target.
 */
export const MIN_STATIONS = 2

/** The configuration that actually measured 36/36 registered, 9,914 points. */
export const MEASURED_GOOD_STATIONS = 5

/**
 * A station contributing fewer frames than this is barely a dome.
 * The 36/36 run averaged ~7 frames per station (two tilt rows across 150° of
 * pan), so 4 is a floor well under what was measured, not a guess at an ideal.
 */
export const MIN_FRAMES_PER_STATION = 4

export interface StationSummary {
  station: number
  frameCount: number
  /**
   * Width of the smallest arc of pan containing this station's frames, in
   * degrees, or null when the frames carried no pan. Diagnostic only.
   */
  panSpreadDeg: number | null
}

export interface StationCoverage {
  /** Every parseable record in keyframes.jsonl. */
  frameCount: number
  /** Records carrying an integer `station`. */
  labelledFrameCount: number
  /** Records with no usable `station` — undiagnosable if the solve fails. */
  framesWithoutStation: number
  /** Lines that were not JSON. Never silently dropped. */
  malformedLines: number
  /** Ascending by station index. */
  stations: StationSummary[]
}

export type StationVerdict =
  /** At least MIN_STATIONS distinct stations — reconstruction is possible. */
  | 'ready'
  /** One station: pure rotation, geometrically incapable of reconstruction. */
  | 'single-station'
  /** Frames exist but none says which station it came from. */
  | 'unlabelled'
  /** No frames at all. */
  | 'empty'

export interface StationAssessment {
  /** False means: do not hand this to COLMAP, it cannot succeed. */
  ok: boolean
  verdict: StationVerdict
  /** One sentence, in the words of someone standing in the room. */
  reason: string
  /** What to do about it, or null when there is nothing to remedy. */
  remediation: string | null
  /** Things worth saying that do not block the capture. */
  warnings: string[]
  coverage: StationCoverage
}

interface RawFrame {
  station: number | null
  pan: number | null
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Width of the smallest arc containing every sample, in degrees.
 *
 * Not `max - min`: the OM6's reachable pan runs roughly +82° … 180° … -100°
 * (it cannot rotate through the front), so a legitimate 150° sweep crosses the
 * ±180 wrap and a naive span would report ~260° for it. Sorting the angles and
 * taking 360 minus the largest gap between neighbours is the wrap-correct
 * answer, and it degrades to `max - min` when nothing wraps.
 */
export function panSpreadDegrees(pans: number[]): number | null {
  if (pans.length === 0) return null
  if (pans.length === 1) return 0
  const sorted = pans.map(p => ((p % 360) + 360) % 360).sort((a, b) => a - b)
  let largestGap = (sorted[0] + 360) - sorted[sorted.length - 1]
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1]
    if (gap > largestGap) largestGap = gap
  }
  const spread = 360 - largestGap
  return Math.round(spread * 10) / 10
}

/** Parse a keyframes.jsonl body into per-station coverage. */
export function summarizeStationCoverage(jsonl: string): StationCoverage {
  const frames: RawFrame[] = []
  let malformedLines = 0

  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      malformedLines += 1
      continue
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      malformedLines += 1
      continue
    }
    const meta = record as Record<string, unknown>
    const stationRaw = meta['station']
    // Integer and non-negative, or it is not a station index. A float or a
    // string here means the capture tool wrote something else into the field,
    // which is exactly the case worth surfacing rather than coercing.
    const station = typeof stationRaw === 'number' && Number.isInteger(stationRaw) && stationRaw >= 0
      ? stationRaw
      : null
    frames.push({ station, pan: asFiniteNumber(meta['pan']) })
  }

  const byStation = new Map<number, number[]>()
  let framesWithoutStation = 0
  for (const frame of frames) {
    if (frame.station === null) {
      framesWithoutStation += 1
      continue
    }
    const pans = byStation.get(frame.station) ?? []
    if (frame.pan !== null) pans.push(frame.pan)
    byStation.set(frame.station, pans)
  }

  // frameCount per station is counted separately from the pan list, because a
  // frame with no pan still contributes an image to the solve.
  const counts = new Map<number, number>()
  for (const frame of frames) {
    if (frame.station === null) continue
    counts.set(frame.station, (counts.get(frame.station) ?? 0) + 1)
  }

  const stations: StationSummary[] = [...byStation.keys()]
    .sort((a, b) => a - b)
    .map(station => ({
      station,
      frameCount: counts.get(station) ?? 0,
      panSpreadDeg: panSpreadDegrees(byStation.get(station) ?? []),
    }))

  return {
    frameCount: frames.length,
    labelledFrameCount: frames.length - framesWithoutStation,
    framesWithoutStation,
    malformedLines,
    stations,
  }
}

/**
 * The honesty gate. A single-station capture cannot reconstruct, and saying so
 * here — while the operator is still in the room with the tripod — is the whole
 * value: the alternative is a COLMAP run that fails confusingly twenty minutes
 * later, having registered 3 of 17 images.
 */
export function assessStationCoverage(coverage: StationCoverage): StationAssessment {
  const stationCount = coverage.stations.length
  const warnings: string[] = []

  if (coverage.malformedLines > 0) {
    warnings.push(`${coverage.malformedLines} line(s) of keyframes.jsonl were not readable and were ignored.`)
  }

  if (coverage.frameCount === 0) {
    return {
      ok: false,
      verdict: 'empty',
      reason: 'This capture has no photos in it.',
      remediation: 'Run a dome sweep from at least two spots in the room before finishing the capture.',
      warnings,
      coverage,
    }
  }

  if (stationCount === 0) {
    return {
      ok: false,
      verdict: 'unlabelled',
      reason:
        `All ${coverage.frameCount} photo(s) arrived without a station number, so there is no way ` +
        'to tell which spot in the room each one was taken from.',
      remediation:
        'The capture tool must send a `station` number with every photo (0 for the first tripod ' +
        'position, 1 for the second, and so on). Without it a failed scan cannot be traced to a spot.',
      warnings,
      coverage,
    }
  }

  if (coverage.framesWithoutStation > 0) {
    warnings.push(
      `${coverage.framesWithoutStation} of ${coverage.frameCount} photo(s) arrived without a station ` +
      'number; they will still be used, but if the scan comes out thin they cannot be traced to a spot.',
    )
  }

  if (stationCount < MIN_STATIONS) {
    return {
      ok: false,
      verdict: 'single-station',
      reason:
        `Every one of these ${coverage.frameCount} photo(s) was taken from the same spot. A camera ` +
        'turning on the spot sees the room from one place only, so there is nothing for the scan to ' +
        'measure depth against — measured on this exact setup, a single spot placed 3 of 17 photos in 3D.',
      remediation:
        `Move the tripod to a different spot in the room and sweep again — that move is what gives the ` +
        `scan its depth. Two spots is the least that can work; ${MEASURED_GOOD_STATIONS} spread around ` +
        'the room (roughly a ring plus one in the middle, not all in a straight line) is what measured ' +
        'a clean result: 36 of 36 photos placed.',
      warnings,
      coverage,
    }
  }

  if (stationCount < MEASURED_GOOD_STATIONS) {
    warnings.push(
      `${stationCount} spots is enough to try, but ${MEASURED_GOOD_STATIONS} spread around the room is ` +
      'what measured a clean result (36 of 36 photos placed). Adding another spot or two is the cheapest ' +
      'way to improve this scan.',
    )
  }

  const thin = coverage.stations.filter(s => s.frameCount < MIN_FRAMES_PER_STATION)
  if (thin.length > 0) {
    warnings.push(
      `Spot(s) ${thin.map(s => s.station).join(', ')} have fewer than ${MIN_FRAMES_PER_STATION} photos, ` +
      'which is too few to cover a dome — those spots will contribute almost nothing.',
    )
  }

  const noSweep = coverage.stations.filter(s => s.panSpreadDeg !== null && s.panSpreadDeg < 1 && s.frameCount > 1)
  if (noSweep.length > 0) {
    warnings.push(
      `Spot(s) ${noSweep.map(s => s.station).join(', ')} took every photo pointing the same way — ` +
      'the gimbal may not have moved between shots.',
    )
  }

  return {
    ok: true,
    verdict: 'ready',
    reason:
      `${coverage.frameCount} photo(s) from ${stationCount} spot(s) in the room — enough movement ` +
      'between spots for the scan to measure depth.',
    remediation: null,
    warnings,
    coverage,
  }
}

/** True when `session.json` says this session was captured as a station dome. */
export function isStationDomeSession(record: unknown): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false
  return (record as Record<string, unknown>)['source'] === STATION_DOME_SOURCE
}

/**
 * Read one session's keyframes.jsonl and summarize it. A missing or unreadable
 * file is empty coverage, not a throw — `assessStationCoverage` already has a
 * verdict for empty, and it is a better message than a filesystem error.
 */
export async function readStationCoverage(sessionPath: string): Promise<StationCoverage> {
  let jsonl = ''
  try {
    jsonl = await Deno.readTextFile(`${sessionPath}/keyframes.jsonl`)
  } catch {
    // No frames posted yet.
  }
  return summarizeStationCoverage(jsonl)
}

/**
 * Preflight for the reconstruction job: the reason this session must not be
 * handed to COLMAP, or null to proceed.
 *
 * Returns null for anything that is not a station-dome session, so a
 * walkthrough or photo-ingest session is unaffected. This is the second place
 * the gate is applied — the capture route refuses first, while the operator is
 * still in the room — because a job can also be re-queued by hand later, and a
 * gate that only lives in one route is a gate with a way around it.
 */
export async function stationCaptureBlockReason(sessionPath: string): Promise<string | null> {
  let record: unknown
  try {
    record = JSON.parse(await Deno.readTextFile(`${sessionPath}/session.json`))
  } catch {
    return null
  }
  if (!isStationDomeSession(record)) return null

  const assessment = assessStationCoverage(await readStationCoverage(sessionPath))
  if (assessment.ok) return null
  return assessment.remediation
    ? `${assessment.reason} ${assessment.remediation}`
    : assessment.reason
}

/**
 * The keyframe field `scripts/ingest-photos.mjs` writes the original upload
 * filename into. It is the only durable link between "the third file the phone
 * posted" and "kf-00002.jpg", because that script re-orders frames by EXIF
 * capture time and drops blurry ones — so the k-th upload is routinely not the
 * k-th keyframe, and matching by position would label frames with a station
 * they were not shot from.
 */
export const SOURCE_PHOTO_FIELD = 'sourcePhoto'

export interface StationLabelResult {
  /** Records that gained a station index. */
  labelled: number
  /** Records the map had nothing for — a frame the photo ingest dropped, or an unlabelled upload. */
  unlabelled: number
}

/**
 * Stamp `station` onto an already-ingested session's keyframes.jsonl.
 *
 * The keyframe *upload* route needs none of this: it spreads the poster's meta
 * into the record verbatim, so a gimbal client's `station` is already there.
 * This exists for the photo path, where the frames pass through an ingest
 * script that renames and re-orders them — the app's tripod capture posts its
 * photos through that route, and without this the station index the operator
 * supplied dies in the upload buffer.
 *
 * Rewrites in place, preserving every other field and every unparseable line
 * exactly as found: a line this cannot read is a line it must not destroy.
 */
export async function applyStationLabels(
  sessionPath: string,
  stationBySourcePhoto: Map<string, number>,
): Promise<StationLabelResult> {
  const path = `${sessionPath}/keyframes.jsonl`
  const raw = await Deno.readTextFile(path)
  let labelled = 0
  let unlabelled = 0
  const out = raw.split('\n').map((line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return line
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      return line
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return line
    const meta = record as Record<string, unknown>
    const source = meta[SOURCE_PHOTO_FIELD]
    const station = typeof source === 'string' ? stationBySourcePhoto.get(source) : undefined
    if (station === undefined) {
      unlabelled += 1
      return line
    }
    labelled += 1
    return JSON.stringify({ ...meta, station })
  })
  await Deno.writeTextFile(path, out.join('\n'))
  return { labelled, unlabelled }
}
