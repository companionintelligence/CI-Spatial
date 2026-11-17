/**
 * What the `place-register` job hands the editor, and the rules for turning it
 * into a scan patch.
 *
 * The server half (server/register/scan_match.ts, place_register.ts) produces a
 * {@link PlaceRegisterResult} and stores it as a job artifact; the editor half
 * (src/viewer/register-proposal.ts) reads it back, previews it and, when a
 * person presses Apply, writes an ordinary scan EditPatch. Both halves import
 * this one file, which is why it lives here and not beside either of them: it
 * has no Deno references and no THREE, so the browser, the server and a Node
 * test can all load it (ADR 0002).
 *
 * ## What a proposal is, and is not
 *
 * A proposal is a measurement and a suggestion. It is never applied by the
 * server (owner decision D17), it never touches `scan.status`, and it never
 * touches the scan's raw `sessionToProject`: the sidecar keeps what the capture
 * measured. The refined placement is the EditPatch a person applies, and the
 * number that backs it travels with the patch as `provenance.residualM`.
 *
 * ## Conventions
 *
 * Matrices are column-major `number[16]`, the layout of `scan.localToWorld`,
 * `THREE.Matrix4.fromArray` and `transformPoint` in ./geo.ts. A proposal's
 * `transform` is a correction **in the Place frame**: it maps a point where the
 * new scan sits now to where it should sit. The new `localToWorld` is therefore
 * `transform · localToWorld`, and {@link multiplyMat4} is the one place that
 * product is taken, so the server's guard and the editor's Apply cannot differ.
 * Yaw is a rotation about +Y (up) by the right-hand rule, the sense
 * `composeYUpTransform` in ./geo.ts uses.
 */
import type { EditPatch, EditPatchProvenance, Quat, ScanManifest, Vec3, WorldJob } from './types.ts'

/** `EditPatchProvenance.source` for a patch applied from a place-register proposal. */
export const PLACE_REGISTER_SOURCE = 'place-register' as const
/** The job artifact that carries a {@link PlaceRegisterResult}. */
export const PLACE_REGISTER_PROPOSAL_ARTIFACT = 'place-register-proposal'
/** The job artifact a run leaves when there was nothing to compare. Its metadata is `{ reason, message }`. */
export const PLACE_REGISTER_SKIP_ARTIFACT = 'place-register-skip'

/**
 * Why a comparison produced no transform. Every one of these means "no move is
 * proposed"; none means "the scans are wrong". The matcher reports the first gate
 * that failed, in the order listed by `matchScans`.
 */
export type RegistrationRefusal =
  /** Fewer wall and obstacle cells than the matcher needs in one of the two scans. */
  | 'too-few-points'
  /** A scan wider than the matcher's working size. */
  | 'too-large'
  /** One of the scans shows no floor to measure heights from. */
  | 'no-floor'
  /** Both floors were found and sit further apart than the vertical bound: probably another level. */
  | 'floor-mismatch'
  /** Too little of the smaller scan lines up with the other at the best position found. */
  | 'low-overlap'
  /** What lines up does not line up closely enough. */
  | 'loose-fit'
  /**
   * The walls do not settle one position: another place within the bound fits about as well (a symmetric room,
   * a row of pillars), or the score barely changes as the scan slides (a corridor, two parallel walls, one wall).
   */
  | 'ambiguous'
  /** The best match needs a bigger move than the named bound allows. */
  | 'correction-too-large'
  /** Every gate passed and the combined score is still below the acceptance score. */
  | 'low-score'

/** The named limits a correction is held to. Each is adopted, not measured (ADR 0005 rule 5). */
export interface CorrectionBound {
  /** Largest move of the scan's centre across the floor, metres. */
  translationM: number
  /** Largest turn about the vertical axis, degrees. */
  yawDeg: number
  /** Largest height change, metres. */
  dyM: number
}

/**
 * How big the best match's correction is, set against the bound it is held to.
 * Present on a refusal too, when the matcher got as far as a best position: the
 * size of a refused correction is the useful part of "too large".
 */
export interface BoundedCorrection {
  /** How far the scan's centre moves across the floor, metres. */
  translationM: number
  /** The turn, degrees. Positive is the right-hand rule about +Y (up). */
  yawDeg: number
  /** The height change, metres. 0 unless both floors were measured. */
  dyM: number
  /** The farthest any wall cell of the scan moves, metres. Information only; the bound is on the three above. */
  maxShiftM: number
  /** True when translation, yaw and height are all inside {@link CorrectionBound}. */
  withinBound: boolean
  bound: CorrectionBound
}

/**
 * Where one scan's floor came from. `'cloud'`: its own lowest well-supported layer, believed.
 * `'hint'`: the cloud showed none, so the calibration's promise (project y = 0) was used.
 * `'hint-over-cloud'`: the cloud's lowest layer sat too far from that promise to be a floor
 * (a platform, a step, a ceiling), so the promise was used instead.
 */
export type FloorSource = 'cloud' | 'hint' | 'hint-over-cloud'

/** What the matcher measured along the way. Kept so a later tuning run can see why a pair passed or failed. */
export interface RegistrationDetails {
  /** Wall and obstacle cells the new scan contributed. */
  movingCells: number
  /** Wall and obstacle cells the reference contributed. */
  referenceCells: number
  /** Share of the new scan's cells that sit within the match gate of a reference cell at the best position. */
  movingMatchedFraction: number
  /** Share of the reference's cells that sit within the match gate of a new-scan cell at the best position. */
  referenceMatchedFraction: number
  /**
   * 0 to 1: how much better the best position is than the best one somewhere else. 1 means nothing
   * comparable was found elsewhere in the search window; 0 means a position elsewhere is as good.
   */
  distinctiveness: number
  /** 0 to 1: how close the lined-up cells are. 1 at or under a 4 cm residual, falling to 0 at the 8 cm residual gate. */
  fit: number
  /** Best other local maximum of the coarse score over the best position's score, 0 to 1. Near 1 means a second place fits as well. */
  peakRatio: number
  /**
   * How far the region of near-best positions reaches, metres: every position that scores at least 85% of the
   * best, joined to it. Small means the walls pin the scan down; null means the region runs to the edge of the
   * search window, so the position is not pinned. A turn counts as the distance the scan's typical cell moves.
   */
  nearBestReachM: number | null
  /** True when both floors were measured from the clouds, so `dyM` is a measurement and not 0 by default. */
  verticalChecked: boolean
  /** Where each floor came from. Only `'cloud'` on both sides makes `verticalChecked` true. Absent on records an earlier build wrote. */
  floors?: { reference: FloorSource; moving: FloorSource }
  /** How far the matcher searched, per axis, metres. */
  searchedTranslationM: number
  /** How far the matcher searched in yaw, degrees, each way. */
  searchedYawDeg: number
}

/**
 * The matcher's answer for one pair of scans.
 *
 * `status: 'proposed'` is the only case with a transform. A refusal still carries
 * the numbers it measured, so a person can see how close it was, but `transform`
 * is null: low overlap, an ambiguous position or an oversize move never leave
 * this function as something a caller could apply by accident.
 */
export interface RegistrationProposal {
  status: 'proposed' | 'refused'
  /** Column-major 4x4 correction in the Place frame. Null unless `status` is `'proposed'`. */
  transform: number[] | null
  /**
   * 0 to 1: how much of the smaller scan lines up with the other at the best position, taking whichever
   * scan is more fully explained by the other (a small scan inside a big one counts as fully overlapping).
   */
  overlapFraction: number
  /** RMS gap, metres, between the cells that line up. Null when none do. */
  inlierResidualM: number | null
  /**
   * 0 to 1: `overlapFraction` times `details.distinctiveness` times `details.fit`, as measured. Reported for
   * refusals too. A refusal for size alone (`'correction-too-large'`) keeps the high score its good match earned,
   * with the size reported beside it; an ambiguous or loose match scores under 0.3.
   */
  score: number
  boundedCorrection: BoundedCorrection | null
  /** Set exactly when `status` is `'refused'`. */
  reason: RegistrationRefusal | null
  details: RegistrationDetails
}

/** A scan as the job saw it, so a stale proposal can be told from a fresh one. */
export interface PlaceRegisterScanRef {
  scanId: string
  filename: string
  name: string
  /** The scan's `localToWorld` when the job ran. A proposal only applies while the scan still has this. */
  localToWorld: number[]
}

/** One reference scan compared with the new scan. Every pair the job tried gets a row, refused or not. */
export interface PlaceRegisterComparison {
  referenceScanId: string
  referenceName: string
  /** `'skipped'` means no comparison ran: the reference had no readable geometry. */
  status: 'proposed' | 'refused' | 'skipped'
  reason: RegistrationRefusal | 'no-geometry' | null
  score: number
  overlapFraction: number
  /** The residual RMS for this pair, metres; null when nothing lined up or nothing was compared. */
  inlierResidualM: number | null
  elapsedMs: number
}

/** Everything the editor needs to preview and apply one proposal. Stored as the job artifact's metadata. */
export interface PlaceRegisterResult {
  /** The best comparison: the highest-scoring proposal, or the highest-scoring refusal when there was none. */
  proposal: RegistrationProposal
  moving: PlaceRegisterScanRef
  /** The reference scan `proposal` was measured against. */
  reference: PlaceRegisterScanRef
  comparisons: PlaceRegisterComparison[]
  /** The thresholds this run used, so a number in `proposal` can be read against them. */
  params: Record<string, number>
  comparedAt: string
  elapsedMs: number
}

// ─── Matrices ────────────────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** True for exactly 16 finite numbers. Indexed, so a sparse array's holes do not slip through. */
export function isMatrix16(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length !== 16) return false
  for (let i = 0; i < 16; i++) {
    if (!isFiniteNumber(value[i])) return false
  }
  return true
}

/**
 * The column-major product `a · b`: the matrix that applies `b` first and `a` second.
 * Both are 4x4. The caller checks them with {@link isMatrix16}.
 */
export function multiplyMat4(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!
      out[col * 4 + row] = sum
    }
  }
  return out
}

/** Both are 16 finite numbers and no entry differs by more than `tolerance`. */
export function matricesAgree(a: unknown, b: unknown, tolerance = 1e-9): boolean {
  if (!isMatrix16(a) || !isMatrix16(b)) return false
  for (let i = 0; i < 16; i++) {
    if (Math.abs(a[i]! - b[i]!) > tolerance) return false
  }
  return true
}

/**
 * Position, rotation and scale of a column-major affine matrix, as the Edit
 * gizmo's `serializeTransform` writes them beside `matrix`. This is
 * `Matrix4.decompose` from three.js (MIT, already a dependency; see
 * THIRD_PARTY.md), ported so the module needs no THREE: a Node test cross-checks
 * it against the real one. Null for a singular matrix.
 */
export function decomposeMatrix(m: readonly number[]): { position: Vec3; rotation: Quat; scale: Vec3 } | null {
  if (!isMatrix16(m)) return null
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!)
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!)
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!)
  if (!(sx > 0 && sy > 0 && sz > 0)) return null
  const det = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) -
    m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) +
    m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!)
  if (det < 0) sx = -sx

  // The rotation block with the scale divided out, named by row then column as three.js names it.
  const m11 = m[0]! / sx, m21 = m[1]! / sx, m31 = m[2]! / sx
  const m12 = m[4]! / sy, m22 = m[5]! / sy, m32 = m[6]! / sy
  const m13 = m[8]! / sz, m23 = m[9]! / sz, m33 = m[10]! / sz

  const trace = m11 + m22 + m33
  let x: number, y: number, z: number, w: number
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    w = 0.25 / s
    x = (m32 - m23) * s
    y = (m13 - m31) * s
    z = (m21 - m12) * s
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33)
    w = (m32 - m23) / s
    x = 0.25 * s
    y = (m12 + m21) / s
    z = (m13 + m31) / s
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33)
    w = (m13 - m31) / s
    x = (m12 + m21) / s
    y = 0.25 * s
    z = (m23 + m32) / s
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22)
    w = (m21 - m12) / s
    x = (m13 + m31) / s
    y = (m23 + m32) / s
    z = 0.25 * s
  }
  return {
    position: { x: m[12]!, y: m[13]!, z: m[14]! },
    rotation: { x, y, z, w },
    scale: { x: sx, y: sy, z: sz },
  }
}

// ─── Reading a proposal back out of a job ────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readScanRef(value: unknown): PlaceRegisterScanRef | null {
  if (!isRecord(value)) return null
  const { scanId, filename, name, localToWorld } = value
  if (typeof scanId !== 'string' || scanId === '') return null
  if (typeof filename !== 'string' || filename === '') return null
  if (typeof name !== 'string') return null
  if (!isMatrix16(localToWorld)) return null
  return { scanId, filename, name, localToWorld }
}

/**
 * The proposal a completed `place-register` job carries, or null.
 *
 * The artifact came out of a JSON file, so every field the editor and the
 * server's guard rely on is checked here rather than trusted: a `'proposed'`
 * result without a 16-number transform, or with no measured residual, is not a
 * proposal. Anything else in the metadata is left alone.
 */
export function readPlaceRegisterResult(job: Pick<WorldJob, 'type' | 'status' | 'artifacts'>): PlaceRegisterResult | null {
  if (job.type !== 'place-register' || job.status !== 'completed') return null
  const metadata = job.artifacts?.find((artifact) => artifact.type === PLACE_REGISTER_PROPOSAL_ARTIFACT)?.metadata
  if (!isRecord(metadata)) return null

  const proposal = metadata['proposal']
  const moving = readScanRef(metadata['moving'])
  const reference = readScanRef(metadata['reference'])
  if (!isRecord(proposal) || !moving || !reference) return null

  const status = proposal['status']
  if (status !== 'proposed' && status !== 'refused') return null
  if (!isFiniteNumber(proposal['score']) || !isFiniteNumber(proposal['overlapFraction'])) return null
  const residual = proposal['inlierResidualM']
  if (residual !== null && !isFiniteNumber(residual)) return null

  const transform = proposal['transform']
  if (status === 'proposed') {
    if (!isMatrix16(transform) || !isFiniteNumber(residual)) return null
  } else if (transform !== null) {
    // A refusal never carries a transform. One that does is not something to offer for applying.
    return null
  }

  const comparisons = Array.isArray(metadata['comparisons']) ? metadata['comparisons'] as PlaceRegisterComparison[] : []
  const params = isRecord(metadata['params']) ? metadata['params'] as Record<string, number> : {}
  return {
    proposal: proposal as unknown as RegistrationProposal,
    moving,
    reference,
    comparisons,
    params,
    comparedAt: typeof metadata['comparedAt'] === 'string' ? metadata['comparedAt'] : '',
    elapsedMs: isFiniteNumber(metadata['elapsedMs']) ? metadata['elapsedMs'] : 0,
  }
}

// ─── Applying a proposal ─────────────────────────────────────────────────────

/** The body POSTed to `/worlds/:slug/patches`. An ordinary scan patch, plus where its numbers came from. */
export interface RegisterPatchBody {
  scope: 'scan'
  scanId: string
  /** The scan's filename, as the gizmo's scan-root patches use. */
  targetId: string
  transform: { matrix: number[]; position: Vec3; rotation: Quat; scale: Vec3 }
  provenance: EditPatchProvenance
}

/**
 * The patch that applies `result`, or null when it proposes nothing.
 *
 * The matrix is the scan's `localToWorld` at proposal time with the correction
 * applied on top, which is what `applyPatchToWorld` on the server stores and
 * what the viewer's `applyStoredPatches` puts on the scan root. Position,
 * rotation and scale ride along exactly as the Edit gizmo writes them.
 */
export function buildRegisterPatch(result: PlaceRegisterResult, jobId: string): RegisterPatchBody | null {
  const { proposal, moving } = result
  if (proposal.status !== 'proposed' || !isMatrix16(proposal.transform) || !isFiniteNumber(proposal.inlierResidualM)) return null
  const matrix = multiplyMat4(proposal.transform, moving.localToWorld)
  const parts = decomposeMatrix(matrix)
  if (!parts) return null
  return {
    scope: 'scan',
    scanId: moving.scanId,
    targetId: moving.filename,
    transform: { matrix, ...parts },
    provenance: {
      source: PLACE_REGISTER_SOURCE,
      jobId,
      score: proposal.score,
      residualM: proposal.inlierResidualM,
    },
  }
}

/** The patch already written for this job, if any. One job is applied at most once. */
export function findAppliedRegisterPatch(patches: readonly EditPatch[], jobId: string): EditPatch | null {
  return patches.find((patch) =>
    patch.scope === 'scan' && patch.provenance?.source === PLACE_REGISTER_SOURCE && patch.provenance.jobId === jobId
  ) ?? null
}

/**
 * Where a proposal stands.
 *
 *  - `'applied'`: a patch with this job's id already exists. Checked first, because
 *    applying moves the scan, and a moved scan would otherwise read as stale.
 *  - `'refused'`: the job proposed no move.
 *  - `'stale'`: the new scan, or the reference it was measured against, is no longer
 *    where the job found it. The proposal described a different arrangement.
 *  - `'ready'`: nothing has moved since the job ran, so Apply is meaningful.
 */
export type RegisterApplyState = 'ready' | 'applied' | 'stale' | 'refused'

export function registerApplyState(
  result: PlaceRegisterResult,
  jobId: string,
  scans: readonly Pick<ScanManifest, 'scanId' | 'localToWorld'>[],
  patches: readonly EditPatch[],
): RegisterApplyState {
  if (findAppliedRegisterPatch(patches, jobId)) return 'applied'
  if (result.proposal.status !== 'proposed') return 'refused'
  const moving = scans.find((scan) => scan.scanId === result.moving.scanId)
  const reference = scans.find((scan) => scan.scanId === result.reference.scanId)
  if (!moving || !reference) return 'stale'
  if (!matricesAgree(moving.localToWorld, result.moving.localToWorld)) return 'stale'
  if (!matricesAgree(reference.localToWorld, result.reference.localToWorld)) return 'stale'
  return 'ready'
}

/** What the world looks like to the Apply step, and how it writes. Injected so the step can be tested without a DOM. */
export interface RegisterApplyDeps {
  scans(): readonly Pick<ScanManifest, 'scanId' | 'localToWorld'>[]
  patches(): readonly EditPatch[]
  /** Writes the patch and, on success, makes `patches()` and `scans()` reflect it. Rejects when the server refuses. */
  post(body: RegisterPatchBody): Promise<void>
}

export type RegisterApplyOutcome = 'applied' | 'already-applied' | 'stale' | 'refused'

/** Jobs whose patch is on its way to the server. A second press while it travels must not send a second one. */
const applying = new Set<string>()

/**
 * Applies a proposal once.
 *
 * Idempotent three ways: a patch for this job already in the world answers
 * `'already-applied'` without writing; a second press while the first is still
 * in flight answers the same; and the server refuses a second patch for one job
 * on its own (`guardRegistrationPatch`), so two tabs cannot both apply it.
 */
export async function applyRegistrationProposal(
  result: PlaceRegisterResult,
  jobId: string,
  deps: RegisterApplyDeps,
): Promise<RegisterApplyOutcome> {
  if (applying.has(jobId)) return 'already-applied'
  const state = registerApplyState(result, jobId, deps.scans(), deps.patches())
  if (state === 'applied') return 'already-applied'
  if (state === 'stale') return 'stale'
  if (state === 'refused') return 'refused'
  const body = buildRegisterPatch(result, jobId)
  if (!body) return 'refused'
  applying.add(jobId)
  try {
    await deps.post(body)
  } finally {
    applying.delete(jobId)
  }
  return 'applied'
}

// ─── Words ───────────────────────────────────────────────────────────────────

/**
 * One short sentence per refusal. These say what was measured and nothing about the
 * scans being right or wrong; no line here says "aligned" or "verified", because
 * nothing this job does earns either word.
 */
const REFUSAL_TEXT: Record<RegistrationRefusal, string> = {
  'too-few-points': 'One of the scans has too few wall points to compare.',
  'too-large': 'One of the scans is too wide to compare.',
  'no-floor': 'No floor was found in one of the scans, so heights cannot be compared.',
  'floor-mismatch': 'The two floors sit too far apart in height. They may be different levels.',
  'low-overlap': 'Too little of the two scans lines up.',
  'loose-fit': 'The walls do not line up closely enough.',
  'ambiguous': 'The walls do not settle one position.',
  'correction-too-large': 'It would take a bigger move than this check allows.',
  'low-score': 'The match is too weak to propose a move.',
}

export function refusalText(reason: RegistrationRefusal | 'no-geometry' | null): string {
  if (reason === 'no-geometry') return 'The reference scan has no readable geometry.'
  return reason ? REFUSAL_TEXT[reason] : 'No move was proposed.'
}

/** Whole centimetres for a distance, or null for a number that does not exist. Never prints "NaN cm". */
function centimetres(metres: number | null | undefined): string | null {
  return typeof metres === 'number' && Number.isFinite(metres) ? Math.abs(metres * 100).toFixed(0) : null
}

function percent(fraction: number): string {
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`
}

/** The lines the editor shows for one result. No claim here goes past what the matcher measured. */
export function describeRegisterResult(result: PlaceRegisterResult): { headline: string; lines: string[] } {
  const { proposal, reference } = result
  const lines: string[] = [`Compared with ${reference.name || reference.filename}.`]

  if (proposal.status !== 'proposed') {
    lines.unshift(refusalText(proposal.reason))
    if (proposal.reason !== 'too-few-points' && proposal.reason !== 'no-floor' && proposal.reason !== 'too-large') {
      lines.push(`${percent(proposal.overlapFraction)} of the smaller scan lines up.`)
    }
    return { headline: 'No move proposed', lines }
  }

  const move = proposal.boundedCorrection
  const shift = centimetres(move?.translationM)
  const turn = move && Number.isFinite(move.yawDeg) ? Math.abs(move.yawDeg).toFixed(1) : null
  const gap = centimetres(proposal.inlierResidualM)
  // `details` comes back out of a JSON artifact, so a record written by an older build may lack it.
  const lift = move && proposal.details?.verticalChecked === true ? centimetres(move.dyM) : null

  const headline = shift !== null && turn !== null
    ? `Proposed move: ${shift} cm and a ${turn}° turn`
    : 'Proposed move'
  lines.push(
    `${percent(proposal.overlapFraction)} of the smaller scan lines up${gap !== null ? `, about ${gap} cm apart` : ''}.`,
  )
  if (lift !== null && lift !== '0') lines.push(`Height changes by ${lift} cm.`)
  lines.push(`Score ${proposal.score.toFixed(2)} out of 1.`)
  lines.push('Nothing moves until you apply it.')
  return { headline, lines }
}
