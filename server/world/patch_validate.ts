/**
 * What the Scan server will take as a placement, and what it does with one it will not.
 *
 * Two routes carry a placement matrix and neither checked it. `POST /worlds/:slug/patches` stored any
 * `transform.matrix` and `applyPatchToWorld` copied it onto the scan, so a NaN made a scan vanish and a
 * skewed matrix smeared it. `POST /upload-scan` wrote the phone's metadata to disk unread, and
 * `matrixFromMeta` accepted any sixteen finite numbers as the scan's calibrated placement.
 *
 * The rules differ by route because the callers do:
 *
 *   - A patch comes from the editor, in a browser that is looking at the answer. A bad matrix is
 *     refused with a 400 and a message the person can read.
 *   - An upload comes from a phone that may be offline. public/sw.js queues the body and, on replay,
 *     deletes it on any 4xx other than 401, 403, 408 and 429 (and says "could not be saved"), so a
 *     4xx here would lose a scan the person was told is safe. The upload is never refused for its
 *     transform: the transform is set aside, the scan is stored and placed by GPS or the grid like
 *     any uncalibrated scan, and the sidecar and manifest say why.
 *
 * This is its own module for the reason server/calibration_fields.ts is: server/main.ts cannot be
 * imported by a test without starting the server. Deno-API-free (ADR 0002); the rules themselves live in
 * src/world/scan-placement.ts so the editor applies the same ones before it asks.
 */
import { checkPlacementMatrix, checkTransformMatrix } from '../../src/world/scan-placement.ts'
import type { EditPatch, ScanManifest, TransformPatch } from '../../src/world/types.ts'

export { checkPlacementMatrix, checkTransformMatrix }

/**
 * A request the world cannot honour, thrown from inside an `updateWorld` mutator so the world is
 * not written (ADR 0004: a throwing mutator saves nothing). The route turns it into its status.
 */
export class PlacementRefused extends Error {
  readonly status: 404 | 409

  constructor(status: 404 | 409, message: string) {
    super(message)
    this.name = 'PlacementRefused'
    this.status = status
  }
}

/** The sub-objects of an EditPatch transform and the numbers each one must hold. */
const TRANSFORM_PARTS = [
  ['position', ['x', 'y', 'z']],
  ['rotation', ['x', 'y', 'z', 'w']],
  ['scale', ['x', 'y', 'z']],
] as const

/**
 * Why a patch body's `transform` may not be stored, or null when it may. A whole scan's matrix must be a
 * valid placement (checkPlacementMatrix); any other target's must be a sound matrix and may be
 * resized along one axis (checkTransformMatrix). Position, rotation and scale, where present, must be
 * real numbers: JSON has no NaN, so one that was NaN arrives as null and is caught here too.
 *
 * A patch with no `transform` (a label, a note, a visibility change) has nothing to check.
 */
export function patchTransformProblem(scope: EditPatch['scope'], transform: unknown): string | null {
  if (transform === undefined || transform === null) return null
  if (typeof transform !== 'object' || Array.isArray(transform)) return 'The transform must be an object.'
  const parts = transform as Record<string, unknown>
  if (parts['matrix'] !== undefined) {
    const check = scope === 'scan' ? checkPlacementMatrix(parts['matrix']) : checkTransformMatrix(parts['matrix'])
    if (!check.ok) return check.message
  }
  for (const [key, names] of TRANSFORM_PARTS) {
    const part = parts[key]
    if (part === undefined) continue
    const values = part && typeof part === 'object' ? part as Record<string, unknown> : null
    if (!values || !names.every((name) => typeof values[name] === 'number' && Number.isFinite(values[name]))) {
      return `The ${key} must be ${names.length} real numbers.`
    }
  }
  return null
}

/**
 * Why a patch body may not be stored, or null when it may: its transform is not sound ({@link patchTransformProblem}), or it
 * is not a scan patch and still moves what the editor will resolve to a whole scan ({@link namesAScanRoot}), which would
 * place the scan round the check a scan's own patch gets.
 */
export function patchProblem(
  patch: { scope: EditPatch['scope']; targetId: string; transform: unknown },
  scans: ReadonlyArray<Pick<ScanManifest, 'scanId' | 'filename' | 'name'>>,
): string | null {
  const problem = patchTransformProblem(patch.scope, patch.transform)
  if (problem) return problem
  const matrix = patch.transform && typeof patch.transform === 'object' ? (patch.transform as { matrix?: unknown }).matrix : undefined
  if (patch.scope !== 'scan' && matrix !== undefined && namesAScanRoot(scans, patch.targetId)) {
    return 'A whole scan is moved with a scan patch, not an object patch.'
  }
  return null
}

/** `text` as a JSON object, or null when it is not JSON or is JSON of another kind (a `null`, a list, a number). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

export type RevertRequest =
  | { ok: true; scanId: string | null; patchId: string | null }
  | { ok: false; message: string }

/**
 * The undo route's request. It has to be a JSON object; `scanId` (which scan to undo) and `patchId` (the move the person
 * saw as the last one, so a stale view cannot undo a different one) are each a non-empty text when they are there.
 * Anything else is refused and not read as "not given": an empty body, half a body or a number where a text belongs would
 * otherwise undo the newest move in the whole world with the stale-view guard switched off. An empty object is still
 * the way to ask for that, on purpose.
 */
export function parseRevertRequest(text: string): RevertRequest {
  const body = parseJsonObject(text)
  if (!body) return { ok: false, message: 'The undo request must be a JSON object.' }
  const ids: Array<string | null> = []
  for (const key of ['scanId', 'patchId'] as const) {
    const value = body[key]
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      return { ok: false, message: `${key} must be text when it is given.` }
    }
    ids.push(typeof value === 'string' ? value : null)
  }
  return { ok: true, scanId: ids[0]!, patchId: ids[1]! }
}

/**
 * The transform a patch stores: only what an EditPatch transform is made of (a matrix, a position, a rotation, a
 * size), and in each of those only the numbers it is made of. Call it on a transform that
 * {@link patchTransformProblem} found nothing wrong with. Anything else the request carried is left out, so a patch
 * stays the size of its matrix however much a request sent, and every reader of the world file only ever finds the
 * four parts it knows.
 */
export function cleanTransform(transform: unknown): TransformPatch | undefined {
  if (transform === undefined || transform === null || typeof transform !== 'object' || Array.isArray(transform)) return undefined
  const parts = transform as Record<string, unknown>
  const out: TransformPatch = {}
  if (Array.isArray(parts['matrix'])) out.matrix = [...parts['matrix'] as number[]]
  for (const [key, names] of TRANSFORM_PARTS) {
    const part = parts[key]
    if (part === undefined || typeof part !== 'object' || part === null) continue
    const values = part as Record<string, number>
    const copy: Record<string, number> = {}
    for (const name of names) copy[name] = values[name]!
    ;(out as Record<string, unknown>)[key] = copy
  }
  return out
}

/**
 * Whether `targetId` is a name the editor resolves to a whole scan: its id, its filename, or its name, which is what
 * the scan's root node is called. A patch with any other scope that moves a node of that name would be replayed onto
 * the scan root, round the check a scan's own patch gets, so the route refuses it.
 */
export function namesAScanRoot(scans: ReadonlyArray<Pick<ScanManifest, 'scanId' | 'filename' | 'name'>>, targetId: string): boolean {
  return scans.some((scan) => scan.scanId === targetId || scan.filename === targetId || (scan.name !== '' && scan.name === targetId))
}

/** What the sidecar and the manifest say when an upload's transform was set aside. */
export interface SanitisedUpload {
  /** The text to write as the scan's sidecar: the phone's own text, unless its transform was set aside. */
  metadata: string
  /** Why the transform was set aside, in plain words, or null when it was not. */
  rejected: string | null
}

/** Most characters of one refused value kept in the sidecar, so a hostile upload cannot grow its own sidecar. Adopted, not measured (ADR 0005 rule 5). */
const MAX_KEPT_ORIGINAL_CHARS = 20_000

/**
 * Most characters of upload metadata that are read at all. Real sidecars are a few tens of kilobytes. Parsing is
 * synchronous, and the server has one thread: a parse of metadata as large as an upload may be (the scan itself
 * is capped at 300 MB) would hold every other request until it finished. Adopted, not measured (ADR 0005 rule 5).
 */
export const MAX_CHECKED_METADATA_CHARS = 8_000_000

/** `value` as it is, or a note of how long it was when it is too long to keep. */
function kept(value: unknown): unknown {
  const text = JSON.stringify(value ?? null)
  return text.length <= MAX_KEPT_ORIGINAL_CHARS ? value ?? null : { omitted: true, characters: text.length }
}

/**
 * The sidecar to store for an upload's metadata, never an error.
 *
 * Metadata that is not JSON, or has no `projectTransform`, is stored exactly as it arrived, which is what the
 * route did before. So is metadata whose transform passes {@link checkPlacementMatrix}: byte for byte, so every
 * sidecar already on disk and every one a current phone writes is unchanged. JSON that is not an object (a
 * `null`, a number, a list) says nothing about the scan and is stored as `{}`: a `null` kept as it came makes
 * every reader of the sidecar throw, and with it every read of every world.
 *
 * A transform that fails is set aside, not refused. The sidecar keeps the scan's other facts and
 * says: `projectTransform` null (so the placement falls to GPS or the grid), the calibration
 * summary 'uncalibrated' with no method (so the editor draws no anchor ring at a point the
 * placement does not use), and the phone's own calibration record null. The refused values are kept
 * under `projectTransformRejected.original`, with the reason, so a later repair can put them back: the
 * refused transform always, and the calibration record unless it is too long to keep.
 *
 * Metadata too long to read ({@link MAX_CHECKED_METADATA_CHARS}) is not read: the scan is stored with a sidecar that
 * only says its placement was not used, and the phone's own text is not kept.
 *
 * `projectTransformRejected` is the server's key. One the phone sends is removed, so an upload
 * cannot flag itself.
 */
export function sanitiseUploadMetadata(raw: string): SanitisedUpload {
  if (raw.length > MAX_CHECKED_METADATA_CHARS) {
    const message = 'The notes sent with this scan were too long to check, so its saved placement was not used.'
    const only = {
      projectTransform: null,
      calibrationMethod: null,
      calibrationStatus: 'uncalibrated',
      calibration: null,
      projectTransformRejected: { reason: 'too-large', message, original: { omitted: true, characters: raw.length } },
    }
    return { metadata: JSON.stringify(only, null, 2), rejected: message }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { metadata: raw, rejected: null }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { metadata: '{}', rejected: null }

  const meta = parsed as Record<string, unknown>
  const claimedFlag = 'projectTransformRejected' in meta
  delete meta['projectTransformRejected']
  const unchanged = (): SanitisedUpload => ({ metadata: claimedFlag ? JSON.stringify(meta) : raw, rejected: null })

  const candidate = meta['projectTransform']
  if (candidate === undefined || candidate === null) return unchanged()
  const check = checkPlacementMatrix(candidate)
  if (check.ok) return unchanged()

  const original = { projectTransform: kept(candidate), calibration: kept(meta['calibration']) }
  meta['projectTransform'] = null
  meta['calibrationMethod'] = null
  meta['calibrationStatus'] = 'uncalibrated'
  meta['calibration'] = null
  meta['projectTransformRejected'] = { reason: check.reason, message: check.message, original }
  return { metadata: JSON.stringify(meta, null, 2), rejected: check.message }
}

/** The reason a sidecar's transform was set aside, in plain words, or undefined when it was not. */
export function rejectedTransformMessage(meta: Record<string, unknown>): string | undefined {
  const flag = meta['projectTransformRejected']
  if (!flag || typeof flag !== 'object') return undefined
  const message = (flag as { message?: unknown }).message
  return typeof message === 'string' && message.length > 0 ? message : 'The saved transform could not be used.'
}

/**
 * The manifest field for a sidecar, always present as a key: the reason when its transform was set aside, undefined when
 * not. The key is always there because refreshWorldScans lays this over the stored row (`{ ...scan, ...next }`): a key that
 * is absent would leave a reason the sidecar no longer gives standing on the row for good, and one that is undefined clears it
 * (and is dropped when the world is written, so a row without a reason stores nothing).
 */
export function rejectedTransformField(meta: Record<string, unknown>): { projectTransformRejected: string | undefined } {
  return { projectTransformRejected: rejectedTransformMessage(meta) }
}
