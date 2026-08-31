/**
 * What survives the tab being thrown away, and what honestly cannot.
 *
 * ## Why this exists
 *
 * Tripod Scan tells someone to set a tripod down, START A SWEEP, WALK OUT OF
 * THE ROOM, come back, pick the tripod up and carry it somewhere else — three
 * to five times. That is several minutes of a phone sitting on a screen nobody
 * is touching, and on 2026-08-29 Chrome did the obvious thing and discarded the
 * tab while the tripod was between spots. Forty-eight photos and a finished
 * spot went with it and the sheet came back at the start screen. The whole
 * capture lived in one `let` in main.ts.
 *
 * Photos are Files, so this needs real storage. It goes in the database the app
 * already has — `'ci-xr-scan'`, in `src/scene/store.ts` — as one more object
 * store beside 'sessions' and 'captures', per ADR 0001. A second database for a
 * third kind of capture is exactly the duplication that ADR forbids, and the
 * database name itself is in CLAUDE.md's do-not-rename table.
 *
 * ## What is worth restoring, and what is not
 *
 * FINISHED SPOTS, YES. A spot is a sweep the operator watched to the end and
 * `endSweep` accepted; it is minutes of walking and it is exactly what
 * `finishVerdict` counts. Losing one to a background tab is losing work that
 * was already done.
 *
 * THE SWEEP THAT WAS RUNNING, NO. It is tempting — there might be thirty photos
 * in it — and it is the wrong call. A sweep interrupted by the tab dying stopped
 * somewhere in the middle of an arc: it photographed part of a room, and nobody
 * watched it finish. Banking it on restore would count a spot the operator never
 * marked finished, which is the precise thing `endSweep` refuses to do when the
 * camera hands over nothing. So the pending photos are not written, and the
 * recovery panel says out loud that the sweep in progress was not kept —
 * {@link RECOVERY_LOST_SWEEP}. Sweeping that one spot again is a minute; a spot
 * that quietly contains half an arc is a room that comes back wrong.
 *
 * THE MEASUREMENT, YES, and only while it still describes something. It is a
 * length between spot 1 and spot {@link MEASURE_AFTER_SPOTS}; if either of those
 * did not come back, it is a length between a spot and a ghost, and
 * {@link restoreTripodCapture} drops it for the same reason `dropSpot` does.
 *
 * ## Why it is a separate, pure module
 *
 * Same reason `station-capture.ts` is: the interesting parts are what gets
 * thrown away and what the operator is told, and both are testable without a
 * browser or an IndexedDB. `src/scene/store.ts` holds only the reads and writes.
 */
import {
  MEASURE_AFTER_SPOTS,
  STATION_MAX,
  STATION_MIN,
  STATION_RECOMMENDED,
  type SpotMeasurement,
  type StationCaptureState,
} from './station-capture.ts'

/** The single record holding the shape of the capture. Keyed by this id. */
export const TRIPOD_META_KEY = 'meta'

/**
 * One finished spot's photos, as one record.
 *
 * Per spot rather than all in one, and under a key that never moves, because
 * `src/scene/store.ts` learned this the hard way with capture frames: a record
 * holding every photo is rewritten in full on every change, so the fifth spot
 * would push four spots' worth of JPEGs through storage to save its own. A key
 * that survives {@link StationCaptureState} reordering means discarding spot 2
 * is one delete and not a rewrite of spots 3, 4 and 5.
 */
export interface TripodSpotRecord {
  id: string
  files: File[]
}

export interface TripodMetaRecord {
  id: typeof TRIPOD_META_KEY
  savedAt: number
  target: number
  measurement: SpotMeasurement | null
  /** The finished spots, in the order they were captured, by record key. */
  spotKeys: string[]
}

/** A fresh key for a spot's photo record. Unique within a database, and stable. */
export function newSpotKey(nowMs: number, seq: number): string {
  return `spot-${nowMs.toString(36)}-${seq.toString(36)}`
}

/** The record describing a capture as it stands. Small: no photos ride on it. */
export function tripodMetaOf(
  state: StationCaptureState,
  spotKeys: readonly string[],
  nowMs: number,
): TripodMetaRecord {
  return {
    id: TRIPOD_META_KEY,
    savedAt: nowMs,
    target: state.target,
    measurement: state.measurement,
    // Only the spots that exist — never `pending`, and never more keys than
    // there are spots, or a restore would look for photos nothing wrote.
    spotKeys: spotKeys.slice(0, state.spots.length).map(String),
  }
}

export interface RestoredCapture {
  state: StationCaptureState
  /** The keys that came back, in order — main.ts keeps writing under these. */
  spotKeys: string[]
  /** `spotFiles[i]` is the photos behind `state.spots[i]`, as before. */
  spotFiles: File[][]
  savedAt: number
}

function isMeasurement(value: unknown): value is SpotMeasurement {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'skipped') return true
  if (kind !== 'measured') return false
  const metres = (value as { metres?: unknown }).metres
  return typeof metres === 'number' && Number.isFinite(metres) && metres > 0
}

/**
 * Rebuild a capture from what storage actually gave back.
 *
 * The count comes from the FILES, not from the record's own numbers. A record
 * saying "spot 3 had 24 photos" whose photo record did not come back is a spot
 * with no photos in it, and restoring the claim without the evidence would put
 * a capture on screen that says 3 spots and uploads 2 — the same
 * success-not-earned failure this path keeps having, arriving through the one
 * door that had not been shut yet.
 *
 * Returns null when nothing survived, which is indistinguishable from having
 * had no capture at all — correctly, because it is.
 */
export function restoreTripodCapture(
  meta: unknown,
  banks: readonly TripodSpotRecord[],
): RestoredCapture | null {
  if (!meta || typeof meta !== 'object') return null
  const raw = meta as Partial<TripodMetaRecord>
  if (!Array.isArray(raw.spotKeys)) return null

  const byKey = new Map<string, File[]>()
  for (const bank of banks) {
    if (!bank || typeof bank.id !== 'string' || !Array.isArray(bank.files)) continue
    const files = bank.files.filter(f => f instanceof File && f.size > 0)
    if (files.length > 0) byKey.set(bank.id, files)
  }

  const spotKeys: string[] = []
  const spotFiles: File[][] = []
  for (const key of raw.spotKeys) {
    const files = typeof key === 'string' ? byKey.get(key) : undefined
    if (!files) continue
    spotKeys.push(key)
    spotFiles.push(files)
  }
  if (spotFiles.length === 0) return null

  const keptAll = spotKeys.length === raw.spotKeys.length
  const measurement = keptAll
    && spotFiles.length >= MEASURE_AFTER_SPOTS
    && isMeasurement(raw.measurement)
    ? raw.measurement
    : null

  const target = typeof raw.target === 'number' && Number.isFinite(raw.target)
    ? Math.round(raw.target)
    : STATION_RECOMMENDED

  return {
    savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
    spotKeys,
    spotFiles,
    state: {
      target: Math.min(STATION_MAX, Math.max(STATION_MIN, Math.max(target, spotFiles.length))),
      // 'move' is where a capture between spots actually is: the tripod is
      // somewhere, these spots are done, and the next thing is to set it down
      // again. It is also the phase that offers the measurement question, so a
      // capture recovered at two spots is still asked.
      phase: 'move',
      spots: spotFiles.map(files => ({ photos: files.length })),
      pending: 0,
      lastSweepEmpty: false,
      measurement,
    },
  }
}

/** Roughly how long ago, in words someone reads once and acts on. */
export function agoText(savedAt: number, nowMs: number): string {
  const ms = nowMs - savedAt
  if (!Number.isFinite(ms) || ms < 90_000) return 'just now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * The banner on a sheet that has just put a capture back.
 *
 * Restoring silently would be worse than not restoring: someone who reopens the
 * app and finds themselves at "spot 3 of 5" without being told why has no idea
 * whether those photos are of this room or of the one they scanned yesterday.
 * So the count, the photos and the age are all in the first sentence, and the
 * way to throw it away is next to it.
 */
export function recoveryHeadline(spots: number, photos: number, savedAt: number, nowMs: number): string {
  return `Picked up where you left off: ${spots} spot${spots === 1 ? '' : 's'}, `
    + `${photos} photo${photos === 1 ? '' : 's'}, from ${agoText(savedAt, nowMs)}.`
}

/**
 * Said whether or not a sweep was actually lost, because the page cannot know:
 * a sweep in progress is never written, so after the fact there is no record of
 * whether there was one. Claiming certainty either way would be inventing it.
 */
export const RECOVERY_LOST_SWEEP =
  'Any sweep that was still running was not kept — only spots you marked finished come back. '
  + 'Carry on from here, or throw the whole thing away and start again.'

export const RECOVERY_DISCARD_LABEL = 'Throw this away and start again'
export const RECOVERY_KEEP_LABEL = 'Carry on with these'
