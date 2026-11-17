/**
 * The Place frame record: what a stored `ProjectSpatialFrame` may contain, how two of them are
 * told apart, and the revision that says which one a Place holds.
 *
 * This file is imported by the server (`server/wp-a-projects.ts`) and by the browser
 * (`src/project/frame-sync.ts`), so it has no Deno or DOM reference (ADR 0002).
 *
 * ## Why a validator
 *
 * The frame is the one durable reference a Place keeps, and until now the server stored whatever
 * the body held (`spatialFrame: 'banana'` was stored as it came). `validateSpatialFrame` is the
 * single statement of what the server will keep. It accepts every frame the app has written:
 * both calibration methods, with or without the fields later builds added (`pointLabels`,
 * `referencePhotos`, `frameId`, `checkPoints`). It rejects what no writer produces and what the server
 * could not safely hold: a value that is not a plain object, a number that is not finite, a method it
 * does not know, a separation shorter than the capture flow allows, a frame id that is not safe in a URL
 * or a file name, more check points than the schema holds, a photo URL that is not one this server
 * serves, an array where an object belongs, or a key that would reach an object's prototype.
 *
 * ## Photo URLs
 *
 * A reference photo is served from one of two paths. The legacy one, `/projects/:id/reference-photos/ref-<role>.jpg`
 * with role `landmark` or `headingMarker`, is one pair per Place, replaced on re-calibration: it is what every
 * frame written so far points at, and it stays valid. The frame-scoped one,
 * `/projects/:id/frames/:frameId/ref-<role>.jpg` (`framePhotoPath`), belongs to one frame generation, so a
 * replaced frame leaves the previous frame's photos where they were; its roles are `landmark`, `heading`, and
 * `check1` to `check3` for the check points. A frame-scoped URL must name the frame it is in: a record that points
 * at another generation's photos, or at a frame it does not have, is refused. A check point's photo may also name
 * the legacy shape with its own role (`ref-check1.jpg`), for a route that serves the check roles from the Place's
 * folder; either way the role must be the one of the slot the photo is in.
 *
 * ## What it does not decide
 *
 * It checks that a frame is well formed, not that it is right. A frame whose two points are the
 * wrong two spots is well formed. Nothing here says a frame was verified (ADR 0005 rule 3).
 *
 * ## Fields later packages add
 *
 * A key this file does not know is kept if it is plain JSON of bounded size: finite numbers,
 * strings, arrays and objects, with no key that reaches a prototype. A package that adds an
 * optional field to the frame type therefore persists without touching this file, and a typed
 * check can be added beside it later. `SPATIAL_FRAME_METHODS` and `SPATIAL_FRAME_FIELDS` below are
 * checked against the frame type at compile time on purpose: a method or a field added to
 * `ProjectSpatialFrame` fails the type check here until it is listed, so the validator cannot
 * silently drift from the type. The type checks in this file cost nothing at run time.
 *
 * ## Revision
 *
 * `Project.spatialFrameRevision` counts the frame writes the server has accepted for a Place. A
 * Place saved before the field existed reads as 0, and so does a Place that was never calibrated.
 * Only the server writes it. See `placeFrameRevision`.
 */
import { MIN_POINT_SEPARATION_M } from './geo.ts'
import type { ProjectSpatialFrame } from './types.ts'

/**
 * Every method a stored frame may carry, in the order the type declares them. A tier added to the frame type (the
 * fiducial tier is WP-14b's) is added here too, with an entry in `SPATIAL_FRAME_FIELDS` and in `MEMBER_CHECKS`: the
 * type check fails until the frame type and all three name it.
 */
export const SPATIAL_FRAME_METHODS = ['two-point-ground', 'ground-tap-compass'] as const
export type SpatialFrameMethod = (typeof SPATIAL_FRAME_METHODS)[number]

/** The member of `ProjectSpatialFrame` that carries method `M`. */
type FrameMember<M extends SpatialFrameMethod> = Extract<ProjectSpatialFrame, { method: M }>

/**
 * The fields of each frame member. Typed against the frame type: a field added to a member
 * of `ProjectSpatialFrame` that is missing here is a compile error, and so is an entry for a field
 * the member does not have, and a method in `SPATIAL_FRAME_METHODS` with no entry. That is the point.
 */
export const SPATIAL_FRAME_FIELDS = {
  'two-point-ground': {
    version: true,
    createdAt: true,
    method: true,
    landmark: true,
    headingMarker: true,
    separationM: true,
    toleranceM: true,
    anchorBearingDeg: true,
    projectBearingDeg: true,
    bearingConvention: true,
    pointLabels: true,
    referencePhotos: true,
    frameId: true,
    checkPoints: true,
  },
  'ground-tap-compass': {
    version: true,
    createdAt: true,
    method: true,
    anchorBearingDeg: true,
    bearingConvention: true,
  },
} as const satisfies { [M in SpatialFrameMethod]: Record<keyof FrameMember<M>, true> }

// Compile-time checks, types only. `Equal` is true only for identical types, and `MustBe` fails to compile
// when handed anything else, so each alias below is an error at its own line when the two sides drift apart.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type MustBe<T extends true> = T

/**
 * `SPATIAL_FRAME_METHODS` lists exactly the methods `ProjectSpatialFrame` declares. A member added to the type
 * and not to the list (the list is what `isPlaceFrameMethod` and the validator read), or the other way round,
 * stops the type check here.
 */
export type SpatialFrameMethodsMatchTheType = MustBe<Equal<SpatialFrameMethod, ProjectSpatialFrame['method']>>

/**
 * Whether a calibration method defines a frame of the Place: a scan calibrated with it has its
 * `sessionToProject`, and so its `localToWorld`, in the Place's frame, and the Place can hold a stored frame of
 * that method. True for the methods a stored frame may carry (`SPATIAL_FRAME_METHODS`): a tier added to the frame
 * type is added to that list, and the type checks in this file say what else has to follow. `'known-distance'` is
 * not one: its matrix carries the camera solve's own coordinates and fixes a size, not where the scan stands in
 * the Place. Neither is a scan that has no calibration (`undefined`).
 *
 * This is the question "can this scan's placement be compared with the Place's other scans". It is not "does
 * this scan have a landmark and a heading marker to draw": the editor's red pins and the scanner's alignment
 * line ask about the two-point tier alone, and keep asking it by name.
 */
export function isPlaceFrameMethod(method: unknown): method is SpatialFrameMethod {
  return typeof method === 'string' && (SPATIAL_FRAME_METHODS as readonly string[]).includes(method)
}

/**
 * Most check points a frame holds, one per check-point photo role. The schema's bound, so a frame is at most five
 * points (the landmark, the heading marker and these), which `MAX_FIT_POINTS` in ./frame-fit.ts leaves room for;
 * the capture flow offers one. **Adopted from the design, not measured (ADR 0005 rule 5).**
 */
/** The roles of the check points' photos, in the order a frame stores the points: the first point's is `check1`. */
export const CHECK_PHOTO_ROLES = ['check1', 'check2', 'check3'] as const
export const MAX_CHECK_POINTS = CHECK_PHOTO_ROLES.length

/**
 * The roles a frame-scoped reference photo is named by: the landmark, the heading marker, then the check points
 * in the order they are stored.
 *
 * The marker is `heading` here, as the package that defined this URL named it, and `headingMarker` everywhere else
 * the schema names it: the frame's field, the legacy photo role and URL, the upload's role and the local key's. The
 * capture flow's own marker id is `heading` too (`MarkerId` in src/ar/project-calibration.ts), which it maps to
 * `headingMarker` when it stores a photo (`ROLE_OF`). So a writer that holds a stored role and builds a
 * frame-scoped path maps `headingMarker` to `heading` once, as `FRAME_ROLE_OF_SLOT` does below for the validator, and
 * a frame-scoped URL named `ref-headingMarker.jpg` is not one this validator accepts.
 */
export const FRAME_PHOTO_ROLES = ['landmark', 'heading', ...CHECK_PHOTO_ROLES] as const
export type FramePhotoRole = (typeof FRAME_PHOTO_ROLES)[number]

/**
 * Longest a frame id may be. **Adopted, not measured (ADR 0005 rule 5):** room and not a figure. A UUID is 36
 * characters and the fallback the capture client mints on a page with no `randomUUID` (the time and random
 * bytes, as `newArRunId` does) is under 30.
 */
export const MAX_FRAME_ID_LENGTH = 64
const FRAME_ID = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_FRAME_ID_LENGTH}}$`)

/**
 * Whether `value` can be a frame id: 1 to `MAX_FRAME_ID_LENGTH` letters, digits, hyphens or underscores. Both
 * shapes a client mints pass. The class is also what is safe where an id goes: a URL path segment
 * (`framePhotoPath`), a directory name under the Place's media folder, and a local key made of
 * `<projectId>:<frameId>:<role>`, where a `:`, a `.` or a `/` in an id would be ambiguous or would climb out.
 *
 * It is a format and not a vocabulary: a name that is also a property of every object (`__proto__`, `constructor`,
 * `toString`) passes, and is an id like any other. It is not safe as a key of a plain object, then. A consumer that
 * counts or groups scans by frame uses a `Map`, or builds the object with `Object.fromEntries` and reads it with
 * `Object.hasOwn`, and never writes `counts[frameId]`.
 */
export function isFrameId(value: unknown): value is string {
  return typeof value === 'string' && FRAME_ID.test(value)
}

/**
 * Farthest from the origin a frame point may be, in metres. Adopted, not measured (ADR 0005 rule
 * 5): it only rules out numbers that cannot be a place in a room, such as 1e300.
 */
export const MAX_FRAME_EXTENT_M = 10_000

/**
 * Widest separation tolerance a frame may carry, in metres. Adopted, not measured (ADR 0005 rule
 * 5). Real frames carry `DEFAULT_SEPARATION_TOLERANCE_M` (0.15); the browser specs store 25 on
 * purpose, to keep the separation check out of the way of what they test.
 */
export const MAX_SEPARATION_TOLERANCE_M = 100

/**
 * How far `separationM` may differ from the distance between the two stored points, in metres.
 * Adopted, not measured (ADR 0005 rule 5). The writer stores the second point at exactly
 * `separationM` from the origin, so this only absorbs the rounding of a copy.
 */
export const SEPARATION_CONSISTENCY_M = 0.001

/** Longest a typed point label may be. Adopted, not measured: the capture field stops at 60. */
export const MAX_FRAME_LABEL_LENGTH = 200

/** Bounds on the plain JSON a frame may hold. Adopted, not measured (ADR 0005 rule 5). */
const MAX_JSON_DEPTH = 6
const MAX_JSON_NODES = 500
const MAX_JSON_STRING = 1000
const MAX_JSON_ARRAY = 64
const MAX_JSON_KEYS = 64

/** Keys that would reach an object's prototype if they were ever assigned. Refused at any depth. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * `/projects/<id>/reference-photos/ref-<role>.jpg`, the legacy URL shape `referencePhotoUrl` serves, for the two
 * markers. The check roles are in it as well: the pattern is the shape of a path in the Place's own photo folder, and
 * a route that learns the check roles there (WP-04b extends the legacy role list) serves a path this accepts.
 */
const LEGACY_PHOTO_URL = new RegExp(
  `^/projects/([A-Za-z0-9_-]{1,80})/reference-photos/ref-(landmark|headingMarker|${CHECK_PHOTO_ROLES.join('|')})\\.jpg$`,
)
/** `/projects/<id>/frames/<frameId>/ref-<role>.jpg`, the frame-scoped shape `framePhotoPath` builds. */
const FRAME_PHOTO_URL = new RegExp(
  `^/projects/([A-Za-z0-9_-]{1,80})/frames/([A-Za-z0-9_-]{1,${MAX_FRAME_ID_LENGTH}})/ref-(${FRAME_PHOTO_ROLES.join('|')})\\.jpg$`,
)
const LOCAL_KEY = /^[A-Za-z0-9_:.-]{1,120}$/

/**
 * What every writer stores in `createdAt`: `new Date().toISOString()`, which is also what a frame is told
 * apart by (`sameSpatialFrame`). A bare number or a word the engine's date parser happens to read is not that.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Where the server serves a Place's reference photo of one point from: the legacy path, fixed by Place and role (one
 * file per role, replaced on re-calibration), so it is known before the upload lands. The same string as
 * `referencePhotoUrl` in server/project_media.ts, which the browser cannot import (ADR 0002);
 * tests/unit/node/wp-spatial-frame.test.ts asserts the two agree and that `validateSpatialFrame` accepts it. It builds
 * the paths of the two markers and of the check points (`check1` to `check3`), which the route serves from the same
 * folder (WP-04b). A frame that has a `frameId` keeps its photos under `framePhotoPath` instead.
 */
export function referencePhotoPath(projectId: string, role: PhotoSlot): string {
  return `/projects/${encodeURIComponent(projectId)}/reference-photos/ref-${role}.jpg`
}

/**
 * Where the server serves one frame generation's reference photo from: fixed by Place, frame and role, so it is
 * known before the upload lands and a later generation never writes over it. `validateSpatialFrame` accepts it
 * for a photo of the right role in a frame whose `frameId` it names. The route that serves it is the server's
 * (WP-08); this function is in the shared file so the browser and the server build the same string.
 */
export function framePhotoPath(projectId: string, frameId: string, role: FramePhotoRole): string {
  return `/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(frameId)}/ref-${role}.jpg`
}

export type SpatialFrameCheck =
  | { ok: true; frame: ProjectSpatialFrame }
  | { ok: false; error: string }

export interface SpatialFrameCheckOptions {
  /** When set, a reference photo URL must name this Place. */
  projectId?: string
}

type Json = Record<string, unknown>

function isPlainObject(value: unknown): value is Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * A copy of `value` if it is plain JSON within the bounds above, else the reason it is not. The
 * copy is built key by key, so nothing the input inherits or hides can reach it. A property whose
 * value is `undefined` is absent, as it is once the value has been through JSON.
 */
function cloneJson(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number },
): { value: unknown } | { error: string } {
  state.nodes += 1
  if (state.nodes > MAX_JSON_NODES) return { error: `${path} is too large` }
  if (value === null || typeof value === 'boolean') return { value }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { value } : { error: `${path} must be a finite number` }
  }
  if (typeof value === 'string') {
    return value.length <= MAX_JSON_STRING ? { value } : { error: `${path} is too long` }
  }
  if (depth >= MAX_JSON_DEPTH) return { error: `${path} is nested too deeply` }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY) return { error: `${path} has too many entries` }
    const copy: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      const item = cloneJson(value[i], `${path}[${i}]`, depth + 1, state)
      if ('error' in item) return item
      copy.push(item.value)
    }
    return { value: copy }
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length > MAX_JSON_KEYS) return { error: `${path} has too many fields` }
    const copy: Json = {}
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) return { error: `${path} has a field the server will not store` }
      if (value[key] === undefined) continue
      const item = cloneJson(value[key], `${path}.${key}`, depth + 1, state)
      if ('error' in item) return item
      copy[key] = item.value
    }
    return { value: copy }
  }
  return { error: `${path} must be plain data` }
}

function numberAt(object: Json, key: string, path: string): number | string {
  const value = object[key]
  return typeof value === 'number' ? value : `${path}.${key} must be a number`
}

/** `{x, y, z}` of finite numbers inside the extent a room can have, or why not. */
function pointError(value: unknown, path: string): string | null {
  if (!isPlainObject(value)) return `${path} must be an object with x, y and z`
  for (const axis of ['x', 'y', 'z']) {
    const n = numberAt(value, axis, path)
    if (typeof n === 'string') return n
    if (Math.abs(n) > MAX_FRAME_EXTENT_M) return `${path}.${axis} is out of range`
  }
  return null
}

function stringAt(object: Json, key: string, path: string, max: number): string | null {
  const value = object[key]
  if (typeof value !== 'string' || value.length === 0) return `${path}.${key} must be text`
  if (value.length > max) return `${path}.${key} is too long`
  return null
}

/**
 * Where a photo record sits in a frame, which says which URL it may name: the landmark's and the heading
 * marker's (`referencePhotos`), or a check point's (`checkPoints[i].photo`, slot `check<i + 1>`).
 */
type PhotoSlot = 'landmark' | 'headingMarker' | (typeof CHECK_PHOTO_ROLES)[number]

/** The role a frame-scoped URL names for each slot. The heading marker's is `heading` there (see `FRAME_PHOTO_ROLES`). */
const FRAME_ROLE_OF_SLOT: Record<PhotoSlot, FramePhotoRole> = {
  landmark: 'landmark',
  headingMarker: 'heading',
  check1: 'check1',
  check2: 'check2',
  check3: 'check3',
}

/**
 * Why `url` is not the path this slot's photo is served from, or null when it is. Two shapes are accepted. The
 * legacy one (`referencePhotoPath`) belongs to the Place, one photo per role, named by the slot itself (the heading
 * marker's is `headingMarker`). The frame-scoped one (`framePhotoPath`) belongs to a frame generation, so it must name
 * the frame it is written in, and the heading marker's role in it is `heading`. A photo may carry either: every frame
 * written so far has the legacy shape, and the work packages that add check points and frame-scoped storage do not
 * land together.
 */
function photoUrlError(
  url: string,
  slot: PhotoSlot,
  path: string,
  options: SpatialFrameCheckOptions,
  frameId: string | undefined,
): string | null {
  const scoped = FRAME_PHOTO_URL.exec(url)
  if (scoped) {
    if (scoped[3] !== FRAME_ROLE_OF_SLOT[slot]) return `${path}.url is another point's photo`
    if (frameId === undefined) return `${path}.url names a frame and this record has no frameId`
    if (scoped[2] !== frameId) return `${path}.url belongs to another frame`
    if (options.projectId !== undefined && scoped[1] !== options.projectId) {
      return `${path}.url belongs to another Place`
    }
    return null
  }

  const legacy = LEGACY_PHOTO_URL.exec(url)
  if (legacy) {
    if (legacy[2] !== slot) {
      const markers = (role: string) => role === 'landmark' || role === 'headingMarker'
      return `${path}.url is ${markers(slot) && markers(legacy[2]!) ? "the other marker's" : "another point's"} photo`
    }
    if (options.projectId !== undefined && legacy[1] !== options.projectId) {
      return `${path}.url belongs to another Place`
    }
    return null
  }
  return `${path}.url is not a reference photo path`
}

function photoError(
  value: unknown,
  slot: PhotoSlot,
  path: string,
  options: SpatialFrameCheckOptions,
  frameId: string | undefined,
): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`

  // `url` is the server path once the photo is uploaded, and null while it is pending or if the
  // upload never landed. Anything else is not a URL this server serves.
  const url = value['url']
  if (url !== null) {
    if (typeof url !== 'string') return `${path}.url must be a server path or null`
    const problem = photoUrlError(url, slot, path, options, frameId)
    if (problem) return problem
  }

  const localKey = value['localKey']
  if (typeof localKey !== 'string' || !LOCAL_KEY.test(localKey)) return `${path}.localKey must be a short key`

  const tapPoint = value['tapPoint']
  if (!isPlainObject(tapPoint)) return `${path}.tapPoint must be an object with x and y`
  for (const axis of ['x', 'y']) {
    const n = numberAt(tapPoint, axis, `${path}.tapPoint`)
    if (typeof n === 'string') return n
    if (n < 0 || n > 1) return `${path}.tapPoint.${axis} must be between 0 and 1`
  }

  const pose = value['pose']
  if (!isPlainObject(pose)) return `${path}.pose must be an object`
  const position = pointError(pose['position'], `${path}.pose.position`)
  if (position) return position
  const rotation = pose['rotation']
  if (!isPlainObject(rotation)) return `${path}.pose.rotation must be an object with x, y, z and w`
  for (const axis of ['x', 'y', 'z', 'w']) {
    const n = numberAt(rotation, axis, `${path}.pose.rotation`)
    if (typeof n === 'string') return n
  }

  return stringAt(value, 'capturedAt', path, 64)
}

function twoPointError(frame: Json, options: SpatialFrameCheckOptions): string | null {
  const landmark = pointError(frame['landmark'], 'spatialFrame.landmark')
  if (landmark) return landmark
  const headingMarker = pointError(frame['headingMarker'], 'spatialFrame.headingMarker')
  if (headingMarker) return headingMarker

  const separationM = frame['separationM']
  if (typeof separationM !== 'number') return 'spatialFrame.separationM must be a number'
  if (separationM < MIN_POINT_SEPARATION_M) {
    return `spatialFrame.separationM must be at least ${MIN_POINT_SEPARATION_M} m`
  }
  if (separationM > MAX_FRAME_EXTENT_M) return 'spatialFrame.separationM is out of range'

  const toleranceM = frame['toleranceM']
  if (typeof toleranceM !== 'number') return 'spatialFrame.toleranceM must be a number'
  if (toleranceM <= 0 || toleranceM > MAX_SEPARATION_TOLERANCE_M) {
    return `spatialFrame.toleranceM must be above 0 and at most ${MAX_SEPARATION_TOLERANCE_M} m`
  }

  // The editor draws the two points as stored, and a later visit measures against separationM, so
  // the two have to describe the same baseline. Ground distance, as twoPointSeparationM measures it.
  const a = frame['landmark'] as Record<string, number>
  const b = frame['headingMarker'] as Record<string, number>
  const stored = Math.hypot(b['x'] - a['x'], b['z'] - a['z'])
  if (Math.abs(stored - separationM) > SEPARATION_CONSISTENCY_M) {
    return 'spatialFrame.separationM does not match the distance between landmark and headingMarker'
  }

  const labels = frame['pointLabels']
  if (labels !== undefined) {
    if (!Array.isArray(labels) || labels.length !== 2) return 'spatialFrame.pointLabels must be two texts'
    for (const label of labels) {
      if (typeof label !== 'string') return 'spatialFrame.pointLabels must be two texts'
      if (label.length > MAX_FRAME_LABEL_LENGTH) return 'spatialFrame.pointLabels has a label that is too long'
    }
  }

  // `validateSpatialFrame` has already refused a frameId that is not one, so this is a frame id or none.
  const frameId = typeof frame['frameId'] === 'string' ? frame['frameId'] : undefined

  const photos = frame['referencePhotos']
  if (photos !== undefined) {
    if (!isPlainObject(photos)) return 'spatialFrame.referencePhotos must be an object'
    for (const role of ['landmark', 'headingMarker'] as const) {
      if (photos[role] === undefined) return `spatialFrame.referencePhotos.${role} is missing`
      const problem = photoError(photos[role], role, `spatialFrame.referencePhotos.${role}`, options, frameId)
      if (problem) return problem
    }
  }

  const checkPoints = frame['checkPoints']
  if (checkPoints !== undefined) return checkPointsError(checkPoints, options, frameId)
  return null
}

/**
 * The check points of a two-point frame: at most `MAX_CHECK_POINTS` of them, each a point in the room's extent with
 * an optional label and an optional photo. Their order is the frame's (`[landmark, headingMarker, ...checkPoints]`),
 * and so is the slot of each photo: the first point's is `check1`. An empty list is kept, as a frame with none.
 */
function checkPointsError(
  checkPoints: unknown,
  options: SpatialFrameCheckOptions,
  frameId: string | undefined,
): string | null {
  if (!Array.isArray(checkPoints)) return 'spatialFrame.checkPoints must be a list'
  if (checkPoints.length > MAX_CHECK_POINTS) return `spatialFrame.checkPoints holds at most ${MAX_CHECK_POINTS} points`
  for (let i = 0; i < checkPoints.length; i++) {
    const path = `spatialFrame.checkPoints[${i}]`
    const point = pointError(checkPoints[i], path)
    if (point) return point
    const entry = checkPoints[i] as Json

    const label = entry['label']
    if (label !== undefined) {
      if (typeof label !== 'string') return `${path}.label must be text`
      if (label.length > MAX_FRAME_LABEL_LENGTH) return `${path}.label is too long`
    }

    if (entry['photo'] !== undefined) {
      const problem = photoError(entry['photo'], CHECK_PHOTO_ROLES[i], `${path}.photo`, options, frameId)
      if (problem) return problem
    }
  }
  return null
}

/**
 * What each frame method requires beyond what every frame has. A method added to `SPATIAL_FRAME_METHODS` without
 * an entry here fails the type check, so a new frame member cannot be accepted without a decision about what it
 * must hold. The one-point member has no fields of its own to check.
 */
const MEMBER_CHECKS: { [M in SpatialFrameMethod]: (frame: Json, options: SpatialFrameCheckOptions) => string | null } = {
  'two-point-ground': twoPointError,
  'ground-tap-compass': () => null,
}

/**
 * Whether `value` is a frame the server may store, and a copy of it if so.
 *
 * The copy is what to store: it is plain data built from the input, so a getter, a prototype or
 * a shared reference in the input cannot reach it. `options.projectId` ties a frame's photo URLs
 * to the Place it is written for.
 */
export function validateSpatialFrame(value: unknown, options: SpatialFrameCheckOptions = {}): SpatialFrameCheck {
  if (!isPlainObject(value)) return { ok: false, error: 'spatialFrame must be an object' }
  const cloned = cloneJson(value, 'spatialFrame', 0, { nodes: 0 })
  if ('error' in cloned) return { ok: false, error: cloned.error }
  const frame = cloned.value as Json

  if (frame['version'] !== 1) return { ok: false, error: 'spatialFrame.version must be 1' }

  const method = frame['method']
  if (!isPlaceFrameMethod(method)) {
    return { ok: false, error: `spatialFrame.method must be ${SPATIAL_FRAME_METHODS.join(' or ')}` }
  }

  const createdAt = frame['createdAt']
  // The pattern also bounds the length (35 characters at the most), so there is no separate cap.
  if (typeof createdAt !== 'string' || !ISO_DATE.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) {
    return { ok: false, error: 'spatialFrame.createdAt must be an ISO date' }
  }

  // Every writer stores the bearing, and null when there was no compass fix. A bearing is an
  // angle, so this bound is the angle's own range and not an adopted figure.
  const bearing = frame['anchorBearingDeg']
  if (bearing !== null && (typeof bearing !== 'number' || bearing < -360 || bearing > 360)) {
    return { ok: false, error: 'spatialFrame.anchorBearingDeg must be a bearing in degrees, or null' }
  }

  // The id names a frame generation, and ends up in URLs, file names and keys: its format is checked on every
  // method, and only the two-point member carries one in the type today.
  const frameId = frame['frameId']
  if (frameId !== undefined && !isFrameId(frameId)) {
    return {
      ok: false,
      error: `spatialFrame.frameId must be 1 to ${MAX_FRAME_ID_LENGTH} letters, digits, hyphens or underscores`,
    }
  }

  const problem = MEMBER_CHECKS[method](frame, options)
  if (problem) return { ok: false, error: problem }
  return { ok: true, frame: frame as unknown as ProjectSpatialFrame }
}

/** The value with every object's keys in sorted order, so equal data prints equally. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (isPlainObject(value)) {
    const sorted: Json = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) sorted[key] = canonical(value[key])
    }
    return sorted
  }
  return value
}

/**
 * Whether two frames are the same record: every field equal, whatever order the keys came in.
 * `createdAt` is part of it, so two calibrations never compare equal by accident.
 */
export function sameSpatialFrame(a: unknown, b: unknown): boolean {
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

/**
 * The revision of the frame a Place holds: how many frame writes the server accepted for it. A
 * Place saved before the field existed, a Place that was never calibrated, and a value that is
 * not a whole number of at least 1 all read as 0.
 */
export function placeFrameRevision(place: { spatialFrameRevision?: unknown } | null | undefined): number {
  const revision = place?.spatialFrameRevision
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0 ? revision : 0
}

/** Whether `value` can be the revision a writer expects to find: a whole number, 0 or more. */
export function isFrameRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}