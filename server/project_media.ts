/**
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
 * marker's role**, never taken from the request — so a Place holds exactly two
 * photos, re-calibration replaces them rather than appending (ticket 0007:
 * "two photos per Place, replaced on re-calibration"), and the `GET :file`
 * parameter reduces to an allowlist rather than a sanitiser.
 */

/**
 * Every Place id this server has ever minted is `proj-default` or
 * `proj-<epoch-ms>` (`main.ts`'s `POST /projects`, and `ProjectStore`'s own
 * `createProject`). The character class is deliberately wider than that and
 * still excludes `.` and `/` entirely, so no accepted id can escape its parent
 * directory — the same shape-then-use contract `sessionDirPath` follows.
 */
export const PROJECT_ID_RE = /^proj-[A-Za-z0-9_-]{1,64}$/

/** The two markers a two-point frame is built from. Order is +Z's definition. */
export const REFERENCE_PHOTO_ROLES = ['landmark', 'headingMarker'] as const
export type ReferencePhotoRole = typeof REFERENCE_PHOTO_ROLES[number]

/** Camera pose at capture, so the vantage point stays recoverable later. */
export interface ReferencePhotoPose {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
}

export interface ReferencePhotoMeta {
  role: ReferencePhotoRole
  /** Normalised 0-1 screen coords of the tap within this frame. */
  tapPoint: { x: number; y: number }
  pose: ReferencePhotoPose
  capturedAt: string
  /** The typed description of the physical feature, when the user gave one. */
  label?: string
}

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
 * An allowlist rather than a sanitiser: only the two names
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
  if (typeof raw !== 'string') return { error: 'Missing meta field' }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { error: 'meta is not valid JSON' }
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'meta is not an object' }

  const role = parsed['role']
  if (!isReferencePhotoRole(role)) {
    return { error: `role must be one of ${REFERENCE_PHOTO_ROLES.join(', ')}` }
  }

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
