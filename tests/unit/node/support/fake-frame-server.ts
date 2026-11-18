/**
 * A stand-in for the server's routes about a Place's reference, as ADR 0011 states them ("Interface for the client slice"), for the
 * tests that run the phone's frame code for real (src/project/frame-sync.ts, src/project/frame-status.ts) against the rules the
 * server will hold it to, and not against a reply a test scripted to please it.
 *
 * It answers:
 *
 *  - `PUT /projects/:id/spatial-frame`: the compare-and-swap write. In the ADR's order: the body, the frame (the real
 *    `validateSpatialFrame`), a replay of the held frame (200 `unchanged`), the revision (a stale one is 409 with `current`), then
 *    the replace rule: another generation has to carry `replaces` naming the frame the SERVER holds (409 `replaces-required`,
 *    `replaces-mismatch`), the same id on another frame is 409 `frame-id-reused`, and a replaced frame goes into the history.
 *  - `GET /projects/:id/frame-status`: the body `FrameStatus` has (projectId, frame, frameId, revision, scanCount, scansByFrame,
 *    unrecordedScans, notInFrameScans, scansOnCurrentFrame, history), built from the scans a test gives it.
 *  - `POST /projects/:id/frames/:frameId/reference-photos`: a photo of a frame the Place holds or held (404 for any other id), with a
 *    role of `FRAME_PHOTO_ROLES` (`headingMarker` accepted as the legacy name of `heading`), answering `{ ok, role, url }`.
 *  - `POST /projects/:id/reference-photos`: the Place's own route, closed (409 `legacy-photos-closed`) once the frame has an id.
 *
 * The decision rules are ported from the server slice (WP-08s: `classifyFrameWrite`, `sameFrameReference`,
 * `frameHistoryEntry` in src/world/frame-generations.ts, `decideReplacement` and `frameStatusOf` in server/place_frames.ts), because
 * that slice is not in the tree this one is built on. The validator, the photo paths and the photo `meta` check are the real
 * ones. Where the two slices are put together, replace the ported functions by those modules: the tests that use this file say what
 * the phone must do against the rules, and need not change.
 *
 * Not a test file: it has no `.test.ts` name, so no runner collects it.
 */
import { parseReferencePhotoMeta } from '../../../../server/project_media_meta.ts'
import {
  FRAME_PHOTO_ROLES,
  type FramePhotoRole,
  framePhotoPath,
  isFrameId,
  isFrameRevision,
  referencePhotoPath,
  sameSpatialFrame,
  validateSpatialFrame,
} from '../../../../src/world/spatial-frame.ts'
import type { FrameHistoryEntry, FrameReplaceReason, ProjectSpatialFrame } from '../../../../src/world/types.ts'
import type { FrameSyncEnv } from '../../../../src/project/frame-sync.ts'

// ── The rules, ported ────────────────────────────────────────────────────────────────────────────────

const HISTORY_LIMIT = 20
const REASONS: readonly string[] = ['override', 'upgrade', 'merge']

const idOf = (frame: unknown): string | null => {
  const id = (frame as { frameId?: unknown } | null | undefined)?.frameId
  return isFrameId(id) ? id : null
}
const createdAtOf = (frame: unknown): string | null => {
  const at = (frame as { createdAt?: unknown } | null | undefined)?.createdAt
  return typeof at === 'string' ? at : null
}

type WriteKind = 'first' | 'same-generation' | 'new-generation' | 'legacy-replacement'

function classify(held: unknown, next: unknown): WriteKind {
  if (held === undefined || held === null) return 'first'
  const heldId = idOf(held)
  const nextId = idOf(next)
  if (heldId !== null || nextId !== null) return heldId === nextId ? 'same-generation' : 'new-generation'
  return createdAtOf(held) === createdAtOf(next) ? 'same-generation' : 'legacy-replacement'
}

/** Every field the same except the photos and names that go with the points: what a frame gains after it is first saved. */
function sameReference(a: unknown, b: unknown): boolean {
  const strip = (frame: unknown): Record<string, unknown> => {
    const copy = { ...(frame as Record<string, unknown>) }
    delete copy['referencePhotos']
    delete copy['pointLabels']
    if (Array.isArray(copy['checkPoints'])) {
      copy['checkPoints'] = copy['checkPoints'].map((point: unknown) => {
        const stripped = { ...(point as Record<string, unknown>) }
        delete stripped['photo']
        delete stripped['label']
        return stripped
      })
    }
    return copy
  }
  return sameSpatialFrame(strip(a), strip(b))
}

type Refusal = 'replaces-required' | 'replaces-mismatch' | 'frame-id-reused'

const REFUSAL_TEXT: Record<Refusal, string> = {
  'replaces-required': 'This Place already has a saved reference, so a new one has to say which it replaces and why.',
  'replaces-mismatch': 'The reference this write replaces is not the one this Place holds now.',
  'frame-id-reused': 'A reference id names one reference. This write uses the id of the saved reference for a different one.',
}

interface Replaces {
  frameId: string | null
  reason: FrameReplaceReason
}

function decide(held: ProjectSpatialFrame, next: ProjectSpatialFrame, replaces: Replaces | null, nowMs: number):
  { ok: true; entry: FrameHistoryEntry | null } | { ok: false; code: Refusal } {
  const kind = classify(held, next)
  if (kind === 'same-generation') {
    if (idOf(held) !== null && !sameReference(held, next)) return { ok: false, code: 'frame-id-reused' }
    return { ok: true, entry: null }
  }
  if (kind === 'first') return { ok: true, entry: null }
  if (replaces === null) return kind === 'legacy-replacement' ? { ok: true, entry: null } : { ok: false, code: 'replaces-required' }
  if (replaces.frameId !== idOf(held)) return { ok: false, code: 'replaces-mismatch' }
  const frame = held as { method?: unknown; separationM?: unknown }
  return {
    ok: true,
    entry: {
      frameId: idOf(held),
      createdAt: createdAtOf(held) ?? '',
      method: (typeof frame.method === 'string' ? frame.method : '') as ProjectSpatialFrame['method'],
      separationM: typeof frame.separationM === 'number' && Number.isFinite(frame.separationM) ? frame.separationM : null,
      supersededAt: new Date(nowMs).toISOString(),
      reason: replaces.reason,
    },
  }
}

/** The body's `replaces`, or why it is a 400. An absent `frameId` is null: a client that holds a frame with no id. */
function readReplaces(value: unknown): { replaces: Replaces | null } | { error: string } {
  if (value === undefined) return { replaces: null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'replaces must be an object with the frameId it replaces and a reason' }
  const { frameId, reason } = value as { frameId?: unknown; reason?: unknown }
  if (typeof reason !== 'string' || !REASONS.includes(reason)) return { error: `replaces.reason must be ${REASONS.join(', ')}` }
  if (frameId !== undefined && frameId !== null && !isFrameId(frameId)) return { error: 'replaces.frameId must be the id of the frame being replaced, or null when it has none' }
  return { replaces: { frameId: frameId ?? null, reason: reason as FrameReplaceReason } }
}

// ── The scans a Place has, for the status ────────────────────────────────────────────────────────────

/** What the status reads of a stored scan. */
export interface ScanFacts {
  calibrationMethod?: string
  calibrationStatus?: string
  /** `ScanManifest.calibrationFrameId`: absent for an unknown generation. */
  calibrationFrameId?: string
  /** `true` for a two-point scan whose commit wrote no Place frame and matched none (a bypassed floor check): it is in no frame. Absent otherwise. */
  calibrationOutsidePlaceFrame?: true
}

/** A scan the way a two-point calibration leaves it, with the generation it names or none. */
export const twoPointScan = (calibrationFrameId?: string): ScanFacts => ({
  calibrationMethod: 'two-point-ground',
  calibrationStatus: 'provisional',
  ...(calibrationFrameId ? { calibrationFrameId } : {}),
})

/** The server's predicate for a scan that is in a Place frame (src/world/frame-generations.ts, `isInPlaceFrame`): the chips and the counts are one rule. */
export const isInPlaceFrame = (scan: ScanFacts): boolean =>
  scan.calibrationMethod === 'two-point-ground' && scan.calibrationStatus !== 'uncalibrated' && scan.calibrationOutsidePlaceFrame !== true

// ── The server ───────────────────────────────────────────────────────────────────────────────────────

export interface Seed {
  projectId?: string
  frame?: ProjectSpatialFrame | null
  revision?: number
  history?: FrameHistoryEntry[]
  scans?: ScanFacts[]
}

export interface StoredPhoto {
  role: string
  label?: string
  bytes: number
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export class FakeFrameServer {
  readonly projectId: string
  frame: ProjectSpatialFrame | null
  revision: number
  history: FrameHistoryEntry[]
  scans: ScanFacts[]
  /** False: every request fails as a network that is down does. */
  online = true
  /** False: the server is older than ADR 0011 and has no route for a frame's photos. */
  framePhotoRoute = true
  /** A status every photo upload is answered with instead of being taken, with the server's own `error` sentence. */
  failPhotosWith: number | null = null
  /** The clock the history's `supersededAt` is read from. */
  nowMs = 1_700_000_000_000
  /** `METHOD /path` of every request, in order. */
  readonly calls: string[] = []
  /** The bodies of the frame writes that were made, in order, whether or not they were accepted. */
  readonly writes: Array<Record<string, unknown>> = []
  /** What each write was answered with, in the same order: a status, and the code when it was a refusal. */
  readonly answers: Array<{ status: number; code?: string }> = []
  /** The photos the server holds, by the path each is served from. */
  readonly photos = new Map<string, StoredPhoto>()
  /** The headers each request carried, in order. */
  readonly headers: Array<Record<string, string>> = []

  constructor(seed: Seed = {}) {
    this.projectId = seed.projectId ?? 'proj-1'
    this.frame = seed.frame ?? null
    this.revision = seed.revision ?? (seed.frame ? 1 : 0)
    this.history = seed.history ?? []
    this.scans = seed.scans ?? []
  }

  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = new URL(String(input), 'http://server')
    this.calls.push(`${method} ${url.pathname}`)
    this.headers.push(Object.fromEntries(new Headers(init?.headers).entries()))
    if (!this.online) throw new TypeError('Failed to fetch')
    return this.route(method, url.pathname, init)
  }) as typeof fetch

  /** A `FrameSyncEnv` over this server, as the phone's frame code takes one. */
  env(extra: Partial<FrameSyncEnv> = {}): FrameSyncEnv {
    return { fetchFn: this.fetch, url: (path) => path, now: () => 1_700_000_001_000, online: () => this.online, ...extra }
  }

  /** The ids of the frames the Place holds or held: the ones a photo is taken for. */
  knownFrameIds(): Set<string> {
    const ids = new Set<string>()
    const current = idOf(this.frame)
    if (current !== null) ids.add(current)
    for (const entry of this.history) if (isFrameId(entry.frameId)) ids.add(entry.frameId)
    return ids
  }

  /** The body `GET /projects/:id/frame-status` answers: ADR 0011's `FrameStatus`. */
  statusBody(): Record<string, unknown> {
    const byFrame = new Map<string, number>()
    let unrecordedScans = 0
    let notInFrameScans = 0
    for (const scan of this.scans) {
      if (!isInPlaceFrame(scan)) notInFrameScans += 1
      else if (scan.calibrationFrameId === undefined) unrecordedScans += 1
      else byFrame.set(scan.calibrationFrameId, (byFrame.get(scan.calibrationFrameId) ?? 0) + 1)
    }
    const scansByFrame = Object.fromEntries(byFrame)
    const frameId = idOf(this.frame)
    let scansOnCurrentFrame = 0
    if (this.frame !== null && frameId !== null) scansOnCurrentFrame = Object.hasOwn(scansByFrame, frameId) ? scansByFrame[frameId]! : 0
    else if (this.frame !== null && this.frame.method === 'two-point-ground') scansOnCurrentFrame = unrecordedScans
    return {
      projectId: this.projectId,
      frame: this.frame,
      frameId,
      revision: this.revision,
      scanCount: this.scans.length,
      scansByFrame,
      unrecordedScans,
      notInFrameScans,
      scansOnCurrentFrame,
      history: this.history,
    }
  }

  private async route(method: string, path: string, init: RequestInit | undefined): Promise<Response> {
    const place = `/projects/${encodeURIComponent(this.projectId)}`
    if (method === 'PUT' && path === `${place}/spatial-frame`) return this.writeFrame(init)
    if (method === 'GET' && path === `${place}/frame-status`) return json(this.statusBody())
    const notFound = (): Response => new Response('404 Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    if (method === 'POST' && path === `${place}/reference-photos`) {
      return this.failPhotosWith === null ? this.legacyPhoto(init) : json({ error: 'The server could not take the photo' }, this.failPhotosWith)
    }
    const scopedFrom = `${place}/frames/`
    const scopedTo = '/reference-photos'
    if (method === 'POST' && path.startsWith(scopedFrom) && path.endsWith(scopedTo) && path.length > scopedFrom.length + scopedTo.length) {
      if (!this.framePhotoRoute) return notFound()
      if (this.failPhotosWith !== null) return json({ error: 'The server could not take the photo' }, this.failPhotosWith)
      return this.framePhoto(decodeURIComponent(path.slice(scopedFrom.length, -scopedTo.length)), init)
    }
    // What Hono answers for a path no route has.
    return notFound()
  }

  private refuse(status: number, body: Record<string, unknown>): Response {
    this.answers.push({ status, ...(typeof body['code'] === 'string' ? { code: body['code'] } : {}) })
    return json(body, status)
  }

  private writeFrame(init: RequestInit | undefined): Response {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    this.writes.push(body)
    const current = { frame: this.frame, revision: this.revision }
    const checked = validateSpatialFrame(body['frame'], { projectId: this.projectId })
    if (!checked.ok) return this.refuse(400, { error: checked.error })
    if (!isFrameRevision(body['expectedRevision'])) return this.refuse(400, { error: 'expectedRevision must be a whole number' })
    const read = readReplaces(body['replaces'])
    if ('error' in read) return this.refuse(400, { error: read.error })

    if (this.frame !== null && sameSpatialFrame(this.frame, checked.frame)) {
      this.answers.push({ status: 200 })
      return json({ revision: this.revision, frame: this.frame, unchanged: true })
    }
    if (body['expectedRevision'] !== this.revision) {
      return this.refuse(409, { error: 'This Place\'s reference changed since it was read.', current })
    }
    if (this.frame !== null) {
      const decision = decide(this.frame, checked.frame, read.replaces, this.nowMs)
      if (!decision.ok) return this.refuse(409, { error: REFUSAL_TEXT[decision.code], code: decision.code, current })
      if (decision.entry) this.history = [...this.history, decision.entry].slice(-HISTORY_LIMIT)
    }
    this.frame = checked.frame
    this.revision += 1
    this.answers.push({ status: 200 })
    return json({ revision: this.revision, frame: this.frame })
  }

  private async readPhoto(init: RequestInit | undefined): Promise<{ meta: { role: string; label?: string }; bytes: number } | Response> {
    const form = init?.body
    if (!(form instanceof FormData)) return json({ error: 'Send the photo as multipart form data: image and meta' }, 400)
    const image = form.get('image')
    if (!(image instanceof Blob)) return json({ error: 'Missing image field' }, 400)
    const raw = form.get('meta')
    // The real check of the Place's own route, which a frame's photo meta shares but for the roles.
    let asked: unknown
    try {
      asked = JSON.parse(String(raw))
    } catch {
      return json({ error: 'meta is not valid JSON' }, 400)
    }
    const role = (asked as { role?: unknown } | null)?.role
    const known = role === 'headingMarker' || (FRAME_PHOTO_ROLES as readonly unknown[]).includes(role)
    if (!known) return json({ error: `role must be one of ${FRAME_PHOTO_ROLES.join(', ')}` }, 400)
    const parsed = parseReferencePhotoMeta(JSON.stringify({ ...(asked as object), role: role === 'heading' ? 'headingMarker' : role === 'headingMarker' || role === 'landmark' ? role : 'landmark' }))
    if ('error' in parsed) return json({ error: parsed.error }, 400)
    return { meta: { role: role === 'headingMarker' ? 'heading' : String(role), ...(parsed.meta.label ? { label: parsed.meta.label } : {}) }, bytes: image.size }
  }

  private async framePhoto(frameId: string, init: RequestInit | undefined): Promise<Response> {
    if (!isFrameId(frameId)) return json({ error: 'Invalid project or frame id' }, 400)
    if (!this.knownFrameIds().has(frameId)) return json({ error: 'This Place has no reference with that id' }, 404)
    const read = await this.readPhoto(init)
    if (read instanceof Response) return read
    const url = framePhotoPath(this.projectId, frameId, read.meta.role as FramePhotoRole)
    this.photos.set(url, { role: read.meta.role, ...(read.meta.label ? { label: read.meta.label } : {}), bytes: read.bytes })
    return json({ ok: true, role: read.meta.role, url })
  }

  private async legacyPhoto(init: RequestInit | undefined): Promise<Response> {
    if (idOf(this.frame) !== null) {
      return json({ error: 'This Place keeps the photos of each reference with that reference. Update the app to add photos.', code: 'legacy-photos-closed' }, 409)
    }
    const read = await this.readPhoto(init)
    if (read instanceof Response) return read
    if (read.meta.role !== 'landmark' && read.meta.role !== 'heading') return json({ error: 'role must be one of landmark, headingMarker' }, 400)
    const url = referencePhotoPath(this.projectId, read.meta.role === 'heading' ? 'headingMarker' : 'landmark')
    this.photos.set(url, { role: read.meta.role, bytes: read.bytes })
    return json({ ok: true, role: read.meta.role === 'heading' ? 'headingMarker' : read.meta.role, url })
  }
}
