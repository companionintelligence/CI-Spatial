/**
 * The pure half of the Place photo storage: the layout, the roles, the paths and the validation of a photo's `meta`.
 * It reads no file and names no Deno API, so a test of the browser side (a spec's stand-in server, say) can import the
 * real validators and be held to the real field names (ADR 0002). The file operations are `./project_media.ts`, which
 * re-exports all of this.
 *
 * Server-side storage layout and validation for a Place's calibration
 * reference photos (wave 09 ticket 0007).
 *
 * This module exists separately from `main.ts` for the same reason
 * `session_id.ts` does: `main.ts` cannot be imported by a test without running
 * its unconditional top-level side effects (hostname resolution, VLM engine
 * load, `Deno.serve`). The path-safety and body-validation logic is the part
 * that must be provable, so it lives where a test can reach it.
 *
 * Layout mirrors `sessionDir()`'s: one directory per Place, named by an id
 * that has been shape-checked first. The filename is **derived from the
 * point's role**, never taken from the request — so a Place holds at most one
 * photo per point (the two markers, and up to three check points, WP-04b),
 * re-calibration replaces them rather than appending (ticket 0007: "two
 * photos per Place, replaced on re-calibration"), and the `GET :file`
 * parameter reduces to an allowlist rather than a sanitiser.
 *
 * ## Frame-scoped photos (ADR 0011)
 *
 * A frame that has a `frameId` keeps its photos under its own folder, `<Place>/frames/<frameId>/ref-<role>.jpg`,
 * served at `/projects/:id/frames/:frameId/ref-<role>.jpg` (`framePhotoPath`, src/world/spatial-frame.ts). A
 * replaced frame leaves the previous frame's photos where they were, so an old photo never shows with a new
 * record, which the one file per role above could not promise. The roles are `FRAME_PHOTO_ROLES`: the capture
 * flow's `heading` for the heading marker, and the check points. The legacy path above stays for the frames
 * written before ids, which is every frame there is today: nothing is migrated, and once the Place holds a frame
 * with an id the legacy upload route is closed, so those photos are never written over by a later frame's.
 */
import {
  FRAME_PHOTO_ROLES,
  type FramePhotoRole,
  framePhotoPath,
  isFrameId,
} from '../src/world/spatial-frame.ts'

export { FRAME_PHOTO_ROLES, type FramePhotoRole }

/**
 * Every Place id this server has ever minted is `proj-default` or
 * `proj-<epoch-ms>` (`main.ts`'s `POST /projects`, and `ProjectStore`'s own
 * `createProject`). The character class is deliberately wider than that and
 * still excludes `.` and `/` entirely, so no accepted id can escape its parent
 * directory — the same shape-then-use contract `sessionDirPath` follows.
 */
export const PROJECT_ID_RE = /^proj-[A-Za-z0-9_-]{1,64}$/

/**
 * The points a Place keeps a photo of: the two markers a two-point frame is built from (order is +Z's definition), then the
 * check points in the order the frame stores them (`check1` is the first; the capture flow offers one). A record written
 * before check points existed names only the first two, and stays valid.
 */
export const REFERENCE_PHOTO_ROLES = ['landmark', 'headingMarker', 'check1', 'check2', 'check3'] as const
export type ReferencePhotoRole = typeof REFERENCE_PHOTO_ROLES[number]

/** Camera pose at capture, so the vantage point stays recoverable later. */
export interface ReferencePhotoPose {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
}

/** What the `meta` field of a photo upload holds, for a photo whose role is of type `R`. */
export interface PhotoMeta<R extends string> {
  role: R
  /** Normalised 0-1 screen coords of the tap within this frame. */
  tapPoint: { x: number; y: number }
  pose: ReferencePhotoPose
  capturedAt: string
  /** The typed description of the physical feature, when the user gave one. */
  label?: string
}

export type ReferencePhotoMeta = PhotoMeta<ReferencePhotoRole>
export type FramePhotoMeta = PhotoMeta<FramePhotoRole>

export function isReferencePhotoRole(value: unknown): value is ReferencePhotoRole {
  return typeof value === 'string' && (REFERENCE_PHOTO_ROLES as readonly string[]).includes(value)
}

/**
 * The directory `id` would name under `root`, or `null` when `id` is not a
 * well-formed Place id. Says nothing about whether it exists — the caller
 * creates or stats it, exactly as the keyframe routes do.
 */
export function projectMediaDirPath(root: string, id: string | null | undefined): string | null {
  if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) return null
  return `${root}/${id}`
}

/** The one filename a given role is ever stored under. */
export function referencePhotoFileName(role: ReferencePhotoRole): string {
  return `ref-${role}.jpg`
}

/**
 * The role a served filename refers to, or `null`.
 *
 * An allowlist rather than a sanitiser: only the names
 * {@link referencePhotoFileName} produces resolve at all, so `../../etc/passwd`
 * and every other traversal spelling fails by not being on the list rather
 * than by being caught.
 */
export function roleForReferencePhotoFile(file: string | null | undefined): ReferencePhotoRole | null {
  if (typeof file !== 'string') return null
  return REFERENCE_PHOTO_ROLES.find((role) => referencePhotoFileName(role) === file) ?? null
}

/** The client-facing URL a stored photo is served from. */
export function referencePhotoUrl(projectId: string, role: ReferencePhotoRole): string {
  return `/projects/${encodeURIComponent(projectId)}/reference-photos/${referencePhotoFileName(role)}`
}

/**
 * The frame-scoped role a name stands for, or `null`: the roles of `FRAME_PHOTO_ROLES`, and `headingMarker` as
 * the legacy name of `heading`.
 */
export function framePhotoRoleOf(value: unknown): FramePhotoRole | null {
  if (value === 'headingMarker') return 'heading'
  return typeof value === 'string' && (FRAME_PHOTO_ROLES as readonly string[]).includes(value) ? value as FramePhotoRole : null
}

/**
 * The directory a frame's photos live in, or `null` when the Place id or the frame id is not well formed
 * (`isFrameId`: letters, digits, hyphens and underscores, so neither can leave its parent folder).
 */
export function framePhotoDirPath(root: string, projectId: string | null | undefined, frameId: string | null | undefined): string | null {
  const dir = projectMediaDirPath(root, projectId)
  return dir !== null && isFrameId(frameId) ? `${dir}/frames/${frameId}` : null
}

/** The one filename a role is ever stored under, inside its frame's folder: the one its URL ends with. */
export function framePhotoFileName(role: FramePhotoRole): string {
  return `ref-${role}.jpg`
}

/** The role a served filename refers to, or `null`: an allowlist, as `roleForReferencePhotoFile` is. */
export function roleForFramePhotoFile(file: string | null | undefined): FramePhotoRole | null {
  if (typeof file !== 'string') return null
  return FRAME_PHOTO_ROLES.find((role) => framePhotoFileName(role) === file) ?? null
}

/** The client-facing URL a frame's stored photo is served from: `framePhotoPath`, as the frame record names it. */
export function framePhotoUrl(projectId: string, frameId: string, role: FramePhotoRole): string {
  return framePhotoPath(projectId, frameId, role)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNormalised(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

/**
 * Validates a `meta` body, mirroring the keyframe handler's shape: parse, then
 * reject anything that is not exactly what the route promised.
 *
 * `tapPoint` is range-checked, not merely typed. It is the whole reason the
 * photo is useful — a crosshair drawn from an out-of-range coordinate lands
 * off the image and points at nothing, which is worse than no crosshair,
 * because the user would still believe it.
 *
 * Returns the parsed meta, or a message naming what was wrong.
 */
export function parseReferencePhotoMeta(raw: unknown): { meta: ReferencePhotoMeta } | { error: string } {
  return parsePhotoMeta(raw, (value) => (isReferencePhotoRole(value) ? value : null), REFERENCE_PHOTO_ROLES)
}

/**
 * `parseReferencePhotoMeta` for a frame-scoped upload: the same checks, with the roles of `FRAME_PHOTO_ROLES`.
 * The heading marker may be named `heading` (the capture flow's name for it, and the one in the photo's URL) or
 * `headingMarker` (the legacy upload's), and comes back as `heading` either way.
 */
export function parseFramePhotoMeta(raw: unknown): { meta: FramePhotoMeta } | { error: string } {
  return parsePhotoMeta(raw, framePhotoRoleOf, FRAME_PHOTO_ROLES)
}

function parsePhotoMeta<R extends string>(
  raw: unknown,
  readRole: (value: unknown) => R | null,
  roles: readonly string[],
): { meta: PhotoMeta<R> } | { error: string } {
  if (typeof raw !== 'string') return { error: 'Missing meta field' }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { error: 'meta is not valid JSON' }
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'meta is not an object' }

  const role = readRole(parsed['role'])
  if (role === null) return { error: `role must be one of ${roles.join(', ')}` }

  const tapPoint = parsed['tapPoint'] as Record<string, unknown> | undefined
  if (!tapPoint || !isNormalised(tapPoint['x']) || !isNormalised(tapPoint['y'])) {
    return { error: 'tapPoint must be { x, y } with both in 0..1' }
  }

  const pose = parsed['pose'] as Record<string, unknown> | undefined
  const position = pose?.['position'] as Record<string, unknown> | undefined
  const rotation = pose?.['rotation'] as Record<string, unknown> | undefined
  if (
    !position || !isFiniteNumber(position['x']) || !isFiniteNumber(position['y']) || !isFiniteNumber(position['z'])
    || !rotation || !isFiniteNumber(rotation['x']) || !isFiniteNumber(rotation['y'])
    || !isFiniteNumber(rotation['z']) || !isFiniteNumber(rotation['w'])
  ) {
    return { error: 'pose must be { position: {x,y,z}, rotation: {x,y,z,w} }' }
  }

  const capturedAt = typeof parsed['capturedAt'] === 'string' && parsed['capturedAt']
    ? parsed['capturedAt'] as string
    : new Date().toISOString()

  const rawLabel = parsed['label']
  const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim().slice(0, 120) : undefined

  return {
    meta: {
      role,
      tapPoint: { x: tapPoint['x'], y: tapPoint['y'] },
      pose: {
        position: { x: position['x'], y: position['y'], z: position['z'] },
        rotation: { x: rotation['x'], y: rotation['y'], z: rotation['z'], w: rotation['w'] },
      },
      capturedAt,
      ...(label ? { label } : {}),
    },
  }
}
