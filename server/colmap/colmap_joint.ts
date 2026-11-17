/**
 * A COLMAP solve over several sessions, one camera each: the frames of a Place's scans in ONE model, so that one set
 * of camera centres can be compared with each session's own recorded ones (server/register/sim3_chain.ts).
 *
 * `runColmapPoses` (colmap_poses.ts) solves one session: one phone, one camera, the session's own folder. Different
 * sessions are different phones, so here each gets its own camera; see colmap_sessions.ts for why, and for what a
 * camera's starting point is. The command lines are colmap_poses.ts's builders, so a COLMAP option that changes its
 * spelling is fixed in one place, and the models are read with its readers.
 *
 * What this does not do: it does not gravity-align the model (the up axis comes from the fit to each session's AR
 * poses, not from a guess at the tilt of the cameras, so `estimateUpAxis` is not called), it does not write into any
 * session's directory (its output is a work directory of its own, so no session's `colmap.poses.json` ever holds
 * another session's frames), it does not judge the solve (which sessions joined and which did not is reported; what to
 * do about it is the registration job's), and it does not keep a reference model between runs.
 */
import { basename, dirname, join, resolve } from '@std/path'
import {
  buildJointPosesJson,
  type ColmapCamera,
  type JointCameraRecord,
  parseCamerasBin,
  parseImagesBin,
  parsePoints3DBin,
} from './colmap_model.ts'
import {
  bestOf,
  colmapNotFoundSkip,
  createStepRunner,
  defaultSpawn,
  exhaustiveMatcherArgs,
  featureExtractorArgs,
  frameFingerprint,
  growMapperArgs,
  isValidSessionDir,
  KEYFRAME_RE,
  listModels,
  locateColmapBin,
  mapperArgs,
  matchesImporterArgs,
  measureSessionBaseline,
  type ColmapPosesRunOptions,
  type ColmapPosesStatus,
  resolveParams,
  sha256Hex,
  type StationBaseline,
} from './colmap_poses.ts'
import {
  countSessionModels,
  deriveSessionCameraPrior,
  type JointFrame,
  jointReaderArgs,
  planSessionFrames,
  type SessionCameraPrior,
  type SessionModelCounts,
  type SkippedFrame,
} from './colmap_sessions.ts'
import type { PipelineManifestBase } from '../../src/world/manifests.ts'
import {
  exhaustiveMatchingVerdict,
  formatMatchList,
  type MatchingPlan,
  type PairImage,
  type PairListOptions,
  type PairListStats,
  planMatching,
} from '../register/pair_list.ts'
import {
  frameKey,
  pairImagesFromKeyframes,
  placementProblem,
  type SessionPlacement,
} from '../register/session_priors.ts'
import { type KeyframeRecord, readJpegDimensions, readKeyframes } from '../splat/splat_train_dataset.ts'

/** One session of a joint solve. */
export interface ColmapJointSession {
  /**
   * Absolute path of the session directory (`scans/sessions/<id>`). Its name, a server session id, is the folder
   * the frames are linked into and the key of every per-session result.
   */
  sessionDir: string
  /**
   * Where this session's frames are in the Place frame: its scan's `sessionToProject` (column-major: a row-major
   * matrix is refused, see `placementProblem`) and the epoch that calibration is valid for. Absent, the session's
   * frames have no Place-frame pose, take part in no pose gate, and (if no session has one) leave the solve to match
   * exhaustively when the image count allows.
   */
  placement?: SessionPlacement
}

export interface ColmapJointRunOptions {
  /**
   * Where the work and the outputs go: `colmap-work/`, `colmap.poses.json`, `colmap-joint.manifest.json`. Created if
   * missing. Not a session directory, and not inside one, however either is spelled (a relative path, a trailing
   * slash, a symbolic link): the check is on where the two really are.
   *
   * It holds the sessions' keyframes (hard links, or copies across devices) and COLMAP's feature database, which is
   * photographs of a private interior in another form. A hard link keeps a photograph alive after its session
   * directory is deleted, so whoever chooses this directory owns deleting it with the scan or the Place that asked for
   * the solve (Apple 5.1.1(i), owner decision D15): a deletion path that removes `scans/sessions/<id>/` alone leaves
   * the frames here.
   */
  outDir: string
  /**
   * At least two sessions, each with at least one keyframe. They are solved, and reported, in session-id order, whatever
   * order they are listed in here.
   */
  sessions: readonly ColmapJointSession[]
  colmapBin?: string
  featureType?: string
  matcherType?: string
  maxImageSize?: number
  /**
   * Gates for the pair list, for a test or for DX9. Defaults are in server/register/pair_list.ts. Name the reference
   * session here (`referenceSessionId`): the sessions the pair list has to tie together are then the ones tied to it.
   */
  pairOptions?: PairListOptions
  /** Replaces the matching plan that would have been built from the sessions' poses. For a test, or for a re-run that must repeat one. */
  matching?: MatchingPlan
  /** Injection seam for tests, as on {@link ColmapPosesRunOptions}. */
  _spawn?: ColmapPosesRunOptions['_spawn']
}

/** What became of one session in a joint solve. */
export interface JointSessionReport {
  sessionId: string
  /** Frames offered to COLMAP. */
  offered: number
  /** Frames left out before COLMAP saw them, and why. */
  skipped: SkippedFrame[]
  /** The camera's starting point, from the keyframes' own field of view. */
  prior: SessionCameraPrior
  /** In the model the poses were read from. */
  registered: number
  /** In another first-pass model and not in that one: the session, or part of it, did not join. */
  inOtherModels: number
  /** In no model. */
  unregistered: number
  /** The lens COLMAP fitted to this session's images; absent when none of them registered. */
  solvedCamera?: JointCameraRecord
  /** The COLMAP camera ids the session's registered images carry. More than one is a surprise worth a look. */
  cameraIds: number[]
  /** The tripod-station baseline, for a session captured that way and placed; absent otherwise. */
  baseline?: StationBaseline
}

export interface ColmapJointMatching {
  kind: 'pairs' | 'exhaustive'
  pairCount: number
  /** Why exhaustive matching was chosen over the pair list, when it was. */
  why?: string
}

export interface ColmapJointManifest extends PipelineManifestBase {
  tool: 'colmap'
  /** Tells a reader this is not a single-session `colmap-poses.manifest.json`. */
  mode: 'joint'
  outDir: string
  posesPath?: string
  /** Frames offered to COLMAP across all sessions. */
  frameCount?: number
  registeredImages?: number
  pointCount?: number
  /** Mean over the triangulated points of COLMAP's own reprojection error, in pixels. */
  meanReprojectionErrorPx?: number
  /** Always false: a joint solve is left in COLMAP's own frame. Up comes from the fit to each session's AR poses. */
  gravityAligned: false
  /** Models the first mapper pass built, largest first. More than one is a solve that did not tie everything together. */
  models?: Array<{ images: number; bySession: Record<string, number> }>
  /** What was matched. Absent when nothing was: the run was skipped before matching. */
  matching?: ColmapJointMatching
  /** What the pair list found, whether or not it was used: pairs by kind, and any session no pair ties to the others. */
  pairStats?: PairListStats
  sessions: JointSessionReport[]
  params: { colmapBin: string; featureType: string; matcherType: string; maxImageSize: number }
  inputFingerprint?: string
  reusedWorkspace?: boolean
}

export interface ColmapJointResult {
  status: ColmapPosesStatus
  manifest: ColmapJointManifest
  /** Absolute path of the written `colmap.poses.json`, when status is 'ok'. */
  posesPath?: string
  registeredImages?: number
  pointCount?: number
  sessions: JointSessionReport[]
  log: string
  exitCode: number
}

/**
 * How much of a JPEG's start is read to find its size, bytes.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** A baseline JPEG from a canvas has its frame header within the first
 * few kilobytes; this is far more than that. **Revisit when** a keyframe is reported unreadable that has a header
 * past this (a large embedded thumbnail or colour profile).
 */
const JPEG_HEADER_BYTES = 256 * 1024

async function readFrameSize(path: string): Promise<{ width: number; height: number } | null> {
  let file: Deno.FsFile | null = null
  try {
    file = await Deno.open(path, { read: true })
    const buffer = new Uint8Array(JPEG_HEADER_BYTES)
    const read = await file.read(buffer)
    const size = readJpegDimensions(buffer.subarray(0, read ?? 0))
    return size ? { width: size.w, height: size.h } : null
  } catch {
    return null
  } finally {
    file?.close()
  }
}

/**
 * Where `path` really is: absolute, with every symbolic link in it resolved as far as the path exists. The part that does
 * not exist yet (an output directory about to be created) is appended as written. Two spellings of one place come out
 * equal, which is what a containment check needs and a text comparison cannot give: a trailing slash, a relative path, a
 * `.` or `..`, a link.
 *
 * It climbs from the whole path to the nearest ancestor that exists and asks `Deno.realPath` about that, with the path
 * exactly as written, so it names the place `Deno.mkdir` will make the directory in. That is not the same place in every
 * process: Deno follows a `..` after a symbolic link as the file system does under `-A`, and reads it as text when the
 * process runs with a permission list (`deno task start` does). Normalising the path first would pick one of the two and
 * be wrong in the other, with a link into a session followed by `..` reading as a place outside it.
 */
export async function locationOf(path: string): Promise<string> {
  const missing: string[] = []
  let existing = path
  for (;;) {
    try {
      return join(await Deno.realPath(existing), ...missing.reverse())
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return resolve(path)
      missing.push(basename(existing))
      existing = parent
    }
  }
}

/** Whether `child` is `parent` or lies inside it, both as {@link locationOf} gives them. */
function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

async function finishJoint(
  manifestPath: string,
  manifest: ColmapJointManifest,
  exitCode: number,
  log: string,
  started: number,
  extra: Partial<ColmapJointResult> = {},
): Promise<ColmapJointResult> {
  const withTiming: ColmapJointManifest = { ...manifest, timing: { elapsedMs: Date.now() - started } }
  try {
    await Deno.writeTextFile(manifestPath, JSON.stringify(withTiming, null, 2))
  } catch {
    // An output directory that vanished mid-run shouldn't mask the real result.
  }
  return { status: withTiming.status, manifest: withTiming, sessions: withTiming.sessions, log, exitCode, ...extra }
}

const nameOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Solve several sessions' keyframes together, one camera per session, into one COLMAP model.
 *
 * What goes in: for each session, its `kf-*.jpg` and `keyframes.jsonl`. What comes out, in `outDir`:
 * `colmap.poses.json` (every registered frame keyed `<sessionId>/kf-NNNNN.jpg`, the lens of each session under
 * `cameras`, in COLMAP's own frame), and `colmap-joint.manifest.json` with, per session, how many frames joined the
 * model, which lens COLMAP fitted, and the camera prior it started from.
 *
 * Matching is chosen from the sessions' poses (`planMatching` in server/register/pair_list.ts): the pairs that can
 * overlap by the AR poses in the Place frame when every session is tied to the others that way, every pair when the
 * poses cannot tie a session and the image count allows it, and a skip with the reason when it does not. COLMAP runs on
 * the CPU only, as in the single-session solve.
 *
 * A session that COLMAP cannot tie to the others is not an error: the run is `'ok'` and the session's report says its
 * frames are in another model or in none. A few of its frames can still land in the model that holds the rest (measured
 * on a session of mirrored images: 3 of 14), so "registered" is not "joined": the fit to each session's recorded poses
 * (`fitSessionToSolver`) and the registration's checks are what refuse such a session. `status` is `'ok'` when COLMAP
 * produced a model at all.
 */
export async function runColmapJointPoses(opts: ColmapJointRunOptions): Promise<ColmapJointResult> {
  const { outDir } = opts
  // `resolveParams` reads the binary, the feature and matcher types and the image size, and nothing of the directory.
  const params = resolveParams({
    sessionDir: outDir,
    colmapBin: opts.colmapBin,
    featureType: opts.featureType,
    matcherType: opts.matcherType,
    maxImageSize: opts.maxImageSize,
  })
  const started = Date.now()
  const manifestPath = `${outDir}/colmap-joint.manifest.json`
  const base: ColmapJointManifest = {
    schemaVersion: 1,
    tool: 'colmap',
    mode: 'joint',
    status: 'error',
    createdAt: new Date().toISOString(),
    outDir,
    gravityAligned: false,
    sessions: [],
    params,
  }
  // A request that cannot be run is refused without touching the disk: until `outDir` is known to be a place of the
  // solve's own, writing even a manifest there could put a file into a session's directory.
  const reject = (error: string): ColmapJointResult => {
    const manifest: ColmapJointManifest = { ...base, error, timing: { elapsedMs: Date.now() - started } }
    return { status: 'error', manifest, sessions: [], log: '', exitCode: 2 }
  }

  // Sessions are taken in session-id order whatever order the caller listed them in, so the same sessions always give
  // the same camera ids, the same database and the same report.
  const requested = opts.sessions
    .map((session) => ({ session, id: basename(session.sessionDir) }))
    .sort((a, b) => nameOrder(a.id, b.id))
  const sessionIds = requested.map((entry) => entry.id)
  const badId = sessionIds.find((id) => !isValidSessionDir(id))
  if (badId !== undefined) return reject(`invalid session directory: ${badId === '' ? '(empty)' : badId}`)
  if (new Set(sessionIds).size !== sessionIds.length) {
    return reject('two of the sessions are the same directory, or have the same session id, so they would share one folder and one camera')
  }
  if (opts.sessions.length < 2) {
    return reject('a joint solve needs at least two sessions; one session is solved by runColmapPoses')
  }
  for (const { session, id } of requested) {
    const problem = placementProblem(session.placement)
    if (problem) return reject(`the placement of ${id} is refused: ${problem}`)
  }
  const outLocation = await locationOf(outDir)
  for (const { session, id } of requested) {
    if (isWithin(outLocation, await locationOf(session.sessionDir))) {
      return reject(`outDir must not be a session directory or inside one (it is ${id}): the solve writes its work there`)
    }
  }
  await Deno.mkdir(outDir, { recursive: true })
  // The poses of an earlier solve of this directory are not this solve's. Whatever happens from here, a reader that finds
  // `colmap.poses.json` finds the answer to this run or nothing.
  try {
    await Deno.remove(`${outDir}/colmap.poses.json`)
  } catch {
    // none there — fine
  }

  const located = await locateColmapBin(params.colmapBin)
  const resolvedBin = located.bin
  if (!resolvedBin) {
    return await finishJoint(manifestPath, {
      ...base,
      status: 'skipped',
      ...colmapNotFoundSkip(params.colmapBin, located.pathProbe),
    }, 0, '', started)
  }
  params.colmapBin = resolvedBin

  // ── What each session offers ──
  interface Offered {
    sessionId: string
    sessionDir: string
    placement?: SessionPlacement
    kept: JointFrame[]
    skipped: SkippedFrame[]
    prior: SessionCameraPrior
    records: KeyframeRecord[]
  }
  const offered: Offered[] = []
  for (const { session, id: sessionId } of requested) {
    const { sessionDir, placement } = session
    const names: string[] = []
    try {
      for await (const entry of Deno.readDir(sessionDir)) {
        if (entry.isFile && KEYFRAME_RE.test(entry.name)) names.push(entry.name)
      }
    } catch {
      return await finishJoint(manifestPath, { ...base, status: 'error', error: `session directory not found: ${sessionId}` }, 2, '', started)
    }
    names.sort()
    const frames: JointFrame[] = []
    const unreadable: SkippedFrame[] = []
    for (const file of names) {
      const size = await readFrameSize(`${sessionDir}/${file}`)
      if (size) frames.push({ file, ...size })
      else unreadable.push({ file, reason: 'unreadable' })
    }
    const planned = planSessionFrames(frames)
    if (!planned) {
      offered.push({
        sessionId, sessionDir, placement, kept: [], skipped: unreadable, records: [],
        prior: deriveSessionCameraPrior(sessionId, [], { width: 0, height: 0 }),
      })
      continue
    }
    // Frames on disk with no line in keyframes.jsonl still go to COLMAP and keep their sequence neighbours: they just
    // have no pose, so they take no part in the pose gates. Their place in capture order is the number in their name.
    const recorded = new Map<string, KeyframeRecord>()
    for (const record of await readKeyframes(sessionDir)) {
      if (typeof record.file === 'string') recorded.set(record.file, record)
    }
    const records = planned.kept.map((frame) => {
      const have = recorded.get(frame.file)
      if (have) return have
      const number = Number(/^kf-(\d+)\.jpg$/.exec(frame.file)?.[1])
      return { file: frame.file, index: Number.isFinite(number) ? number : 0 } as KeyframeRecord
    })
    offered.push({
      sessionId, sessionDir, placement,
      kept: planned.kept,
      skipped: [...unreadable, ...planned.skipped],
      prior: deriveSessionCameraPrior(sessionId, records, { width: planned.width, height: planned.height }),
      records,
    })
  }
  const withFrames = offered.filter((session) => session.kept.length > 0)
  const totalFrames = withFrames.reduce((n, session) => n + session.kept.length, 0)
  const reportSkeleton = (): JointSessionReport[] =>
    offered.map((session) => ({
      sessionId: session.sessionId,
      offered: session.kept.length,
      skipped: session.skipped,
      prior: session.prior,
      registered: 0,
      inOtherModels: 0,
      unregistered: session.kept.length,
      cameraIds: [],
    }))
  if (withFrames.length < 2 || totalFrames < 3) {
    return await finishJoint(manifestPath, {
      ...base,
      status: 'skipped',
      frameCount: totalFrames,
      sessions: reportSkeleton(),
      skippedReason: withFrames.length < 2
        ? `only ${withFrames.length} session(s) have usable keyframes — a joint solve needs at least two`
        : `only ${totalFrames} keyframe(s) in the sessions — structure-from-motion needs at least 3`,
      remediation: 'Capture more frames in each session, walking between them so the views have parallax.',
    }, 0, '', started)
  }

  // ── How to match ──
  const pairImages: PairImage[] = withFrames.flatMap((session) =>
    pairImagesFromKeyframes(session.records, session.sessionId, session.placement)
  )
  const plan = opts.matching ?? planMatching(pairImages, opts.pairOptions)
  const skipMatching = (reason: string, stats?: PairListStats) =>
    finishJoint(manifestPath, {
      ...base,
      status: 'skipped',
      frameCount: totalFrames,
      sessions: reportSkeleton(),
      ...(stats ? { pairStats: stats } : {}),
      skippedReason: reason,
      remediation: 'Give each session a calibration so its poses place its frames in the Place frame, or use fewer keyframes per session.',
    }, 0, '', started)
  if (plan.kind === 'refused') return await skipMatching(plan.message, plan.stats)
  if (plan.kind === 'exhaustive') {
    // The limit on exhaustive matching holds for a plan handed in as much as for one made here.
    const verdict = exhaustiveMatchingVerdict(totalFrames)
    if (!verdict.allowed) return await skipMatching(verdict.reason, plan.stats)
  }
  const matchList = plan.kind === 'pairs' ? formatMatchList(plan.pairs) : ''
  const matching: ColmapJointMatching = plan.kind === 'pairs'
    ? { kind: 'pairs', pairCount: plan.pairs.length }
    : { kind: 'exhaustive', pairCount: plan.pairCount, why: plan.why }

  // ── The workspace: never one solve's answer for another's frames ──
  const work = `${outDir}/colmap-work`
  const imagesDir = `${work}/images`
  const listsDir = `${work}/lists`
  const fingerprintPath = `${work}/input.fingerprint`
  const sessionFingerprints: Array<{ id: string; frames: string; camera: string | null; size: string }> = []
  for (const session of withFrames) {
    sessionFingerprints.push({
      id: session.sessionId,
      frames: await frameFingerprint(session.sessionDir, session.kept.map((frame) => frame.file)),
      camera: session.prior.params ? session.prior.params.join(',') : null,
      size: `${session.prior.width}x${session.prior.height}`,
    })
  }
  sessionFingerprints.sort((a, b) => nameOrder(a.id, b.id))
  const fingerprint = await sha256Hex(new TextEncoder().encode(JSON.stringify({
    sessions: sessionFingerprints,
    matching: { kind: plan.kind, pairs: await sha256Hex(new TextEncoder().encode(matchList)) },
    params: { featureType: params.featureType, matcherType: params.matcherType, maxImageSize: params.maxImageSize },
  })))
  let cachedFingerprint: string | null = null
  try {
    cachedFingerprint = (await Deno.readTextFile(fingerprintPath)).trim()
  } catch {
    // No record of what the workspace was built from.
  }
  let workspaceExists = true
  try {
    await Deno.stat(work)
  } catch {
    workspaceExists = false
  }
  const reusedWorkspace = workspaceExists && cachedFingerprint === fingerprint
  if (workspaceExists && !reusedWorkspace) {
    console.warn(
      `[colmap-joint] ${outDir}: the sessions, their cameras, the pairs or the settings changed since the last solve ` +
      `(${cachedFingerprint ? `${cachedFingerprint.slice(0, 12)} → ${fingerprint.slice(0, 12)}` : 'no recorded fingerprint'}) ` +
      '— discarding colmap-work/ and re-solving from scratch',
    )
    await Deno.remove(work, { recursive: true })
  }
  await Deno.mkdir(listsDir, { recursive: true })
  await Deno.writeTextFile(fingerprintPath, fingerprint)

  // Frames are linked (copied across devices) into `images/<sessionId>/`, the layout one-camera-per-folder reads.
  for (const session of withFrames) {
    const folder = `${imagesDir}/${session.sessionId}`
    await Deno.mkdir(folder, { recursive: true })
    for (const frame of session.kept) {
      const dest = `${folder}/${frame.file}`
      try {
        await Deno.remove(dest)
      } catch {
        // not present — fine
      }
      try {
        await Deno.link(`${session.sessionDir}/${frame.file}`, dest)
      } catch {
        await Deno.copyFile(`${session.sessionDir}/${frame.file}`, dest)
      }
    }
    await Deno.writeTextFile(
      `${listsDir}/${session.sessionId}.txt`,
      session.kept.map((frame) => frameKey(session.sessionId, frame.file)).join('\n') + '\n',
    )
  }
  const frameCount = totalFrames

  const spawn = opts._spawn ?? defaultSpawn
  const db = `${work}/db.db`
  const logs: string[] = []
  const step = createStepRunner(spawn, params.colmapBin, logs)
  const soFar = {
    ...base,
    frameCount,
    matching,
    pairStats: plan.stats,
    sessions: reportSkeleton(),
    inputFingerprint: fingerprint,
    reusedWorkspace,
  }

  // ── Features: one call per session, so each camera starts from its own prior ──
  let err: string | null = null
  for (const session of withFrames) {
    err = await step(
      `feature_extractor(${session.sessionId})`,
      featureExtractorArgs(params, db, imagesDir, jointReaderArgs(`${listsDir}/${session.sessionId}.txt`, session.prior)),
    )
    if (err) return await finishJoint(manifestPath, { ...soFar, status: 'error', error: err }, 2, logs.join('\n'), started)
  }

  // ── Matches ──
  if (plan.kind === 'pairs') {
    const pairsPath = `${work}/pairs.txt`
    await Deno.writeTextFile(pairsPath, matchList)
    err = await step('matches_importer', matchesImporterArgs(params, db, pairsPath))
  } else {
    err = await step('exhaustive_matcher', exhaustiveMatcherArgs(params, db))
  }
  if (err) return await finishJoint(manifestPath, { ...soFar, status: 'error', error: err }, 2, logs.join('\n'), started)

  // ── The model ──
  // The mapper adds models to a directory and never clears it, so a reused workspace would still hold the models of the
  // run before, and the sub-model report below would count them. The features and matches are what the reuse is for.
  const sparse = `${work}/sparse`
  const grown = `${work}/sparse_grown`
  for (const stale of [sparse, grown]) {
    try {
      await Deno.remove(stale, { recursive: true })
    } catch {
      // none there — fine
    }
  }
  await Deno.mkdir(sparse, { recursive: true })
  err = await step('mapper', mapperArgs(db, imagesDir, sparse))
  if (err) return await finishJoint(manifestPath, { ...soFar, status: 'error', error: err }, 2, logs.join('\n'), started)

  // By directory name, so the same models are always listed in the same order whatever order the listing gives them.
  const firstPass = (await listModels(sparse)).sort((a, b) => nameOrder(a.dir, b.dir))
  const largest = firstPass.reduce<(typeof firstPass)[number] | null>((best, model) => (!best || model.count > best.count ? model : best), null)
  if (!largest) {
    return await finishJoint(manifestPath, {
      ...soFar,
      status: 'error',
      error:
        'COLMAP registered no images — the views share no triangulatable baseline. ' +
        'This is the signature of a rotation-only capture (a camera panning in place); ' +
        'walking between viewpoints is what produces the parallax SfM needs.',
      remediation: 'Re-capture while walking through the space rather than rotating in place.',
    }, 2, logs.join('\n'), started)
  }

  // Second pass, seeded from the largest first-pass model, for the reason in colmap_poses.ts's header. A session COLMAP
  // built as a model of its own may still attach here, so "did it join" is read from the model that comes out of this.
  await Deno.mkdir(grown, { recursive: true })
  const growErr = await step('mapper(grow)', growMapperArgs(db, imagesDir, largest.dir, grown))
  const modelDir = growErr ? largest.dir : await bestOf(grown, largest.dir)

  const images = parseImagesBin(await Deno.readFile(`${modelDir}/images.bin`))
  if (images.length === 0) {
    return await finishJoint(manifestPath, { ...soFar, status: 'error', error: 'model contains no registered images' }, 2, logs.join('\n'), started)
  }
  let pointCount = 0
  let reprojectionSum = 0
  try {
    const points = parsePoints3DBin(await Deno.readFile(`${modelDir}/points3D.bin`))
    pointCount = points.length
    for (const point of points) reprojectionSum += point.error
  } catch {
    // No cloud is survivable: the poses are what the registration reads.
  }
  let cameras: ColmapCamera[] = []
  try {
    cameras = parseCamerasBin(await Deno.readFile(`${modelDir}/cameras.bin`))
  } catch {
    // Without cameras.bin the lens of each session is simply not recorded.
  }
  const cameraById = new Map(cameras.map((camera) => [camera.cameraId, camera]))

  // ── Which sessions joined ──
  const offeredNames = new Map<string, string[]>(
    withFrames.map((session) => [session.sessionId, session.kept.map((frame) => frameKey(session.sessionId, frame.file))]),
  )
  const finalNames = new Set(images.map((image) => image.name))
  const counts = countSessionModels(offeredNames, finalNames, firstPass.map((model) => model.names))
  const reports: JointSessionReport[] = []
  const lenses: Record<string, JointCameraRecord> = {}
  for (const session of offered) {
    const count: SessionModelCounts = counts.get(session.sessionId) ??
      { registered: 0, inOtherModels: 0, unregistered: 0 }
    const mine = images.filter((image) => image.name.startsWith(`${session.sessionId}/`))
    const cameraIds = [...new Set(mine.map((image) => image.cameraId))].sort((a, b) => a - b)
    const solved = cameraIds.length > 0 ? cameraById.get(cameraIds[0]!) : undefined
    const lens = solved
      ? { fx: solved.fx, fy: solved.fy, cx: solved.cx, cy: solved.cy, width: solved.width, height: solved.height }
      : undefined
    if (lens) lenses[session.sessionId] = lens
    const baseline = session.kept.length > 0
      ? await measureSessionBaseline(session.sessionDir, images, { folder: session.sessionId })
      : null
    reports.push({
      sessionId: session.sessionId,
      offered: session.kept.length,
      skipped: session.skipped,
      prior: session.prior,
      ...count,
      ...(lens ? { solvedCamera: lens } : {}),
      cameraIds,
      ...(baseline ? { baseline } : {}),
    })
  }

  const posesPath = `${outDir}/colmap.poses.json`
  await Deno.writeTextFile(posesPath, JSON.stringify(buildJointPosesJson(images, lenses), null, 2))

  return await finishJoint(manifestPath, {
    ...soFar,
    status: 'ok',
    posesPath: 'colmap.poses.json',
    registeredImages: images.length,
    pointCount,
    ...(pointCount > 0 ? { meanReprojectionErrorPx: reprojectionSum / pointCount } : {}),
    models: firstPass
      .map((model) => ({
        images: model.count,
        bySession: Object.fromEntries(
          [...offeredNames.keys()].map((id) => [id, [...model.names].filter((name) => name.startsWith(`${id}/`)).length]),
        ),
      }))
      .sort((a, b) => b.images - a.images),
    sessions: reports,
  }, 0, logs.join('\n'), started, { posesPath, registeredImages: images.length, pointCount, sessions: reports })
}
