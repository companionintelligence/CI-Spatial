/**
 * Panoptic-lift driver — turns `panoptic.segments.json` into world positions.
 *
 * `panoptic-scan` answers "what objects are in these frames". This answers
 * "where are they", which is the only form the rest of the system can use: a
 * `Thing` is a label AND a place, and `thing_match.ts` fuses on position.
 *
 * Inputs, all already on disk:
 *
 *   scans/sessions/<id>/panoptic.segments.json   thing segments (label, score,
 *                                                areaPx, centroidPx)
 *   scans/sessions/<id>/keyframes.jsonl          per-frame pose + intrinsics
 *   scans/sessions/<id>/kf-*.jpg                 the pixel frame the centroids
 *                                                are in
 *   scans/<base>.glb                             the scan's point cloud
 *
 * Output:
 *
 *   scans/<base>.panoptic.detections.json        one record per thing segment
 *   scans/<base>.panoptic-lift.manifest.json     counts + why
 *
 * Every policy decision lives in `src/shared/panoptic_lift.ts` (pure, ADR 0002)
 * so it can be tuned and tested without a session on disk. This file is only
 * I/O, joining, and the honest bookkeeping.
 *
 * ── Why a sidecar and not the scan's meta JSON ───────────────────────────────
 *
 * server/main.ts:1930 rewrites the whole `<base>.json` meta sidecar with
 * `void Deno.writeTextFile(...)` — unawaited, and outside the per-slug world
 * lock ADR 0004 establishes. A stage that merged into that same file would be
 * last-write-wins against an ingest that is still in flight. A separate file
 * per producer is the precedent `splat_detect.ts` already set with
 * `<base>.interactions.json`, and it makes a re-lift an idempotent whole-file
 * overwrite instead of a merge. The shape is `StoredDetectionMeta` plus
 * provenance, and it converges at `detectionLikesForWorld` — one aggregation
 * point, not a second data model (ADR 0001).
 *
 * ── When a solved camera track may be used, and when it may not ──────────────
 *
 * `buildBrushDataset` falls back from a capture pose to `readSolvedPoses`
 * (COLMAP / LingBot-Map) per frame. That is right for a trainer, which only
 * needs cameras consistent with each other. Here it is right only under a
 * condition, and the condition is the whole of it.
 *
 * Monocular SfM reconstructs only up to an unknown scale, at an arbitrary
 * origin and heading — the reason `SplatAlignManifest` exists at all
 * (src/world/manifests.ts). A position lifted from a COLMAP pose with nothing
 * to fix that scale is not merely imprecise, it is in a different space and a
 * different unit, and `thing_match` would fuse it against real metres at a
 * 0.75 m radius. But that objection is entirely about the ABSENCE of a metric
 * frame, and it lapses exactly when one exists: a verified `splat-align`
 * manifest carries `projectTransform` (solver space → project metres, the
 * scale already folded in) together with the `residualM` that says how well it
 * actually fits. Carried through that, a solved camera IS in the right space
 * and the right unit, and so is the cloud it is cast against.
 *
 * So the rule is:
 *
 *   - a frame with a capture pose lifts against the capture-frame cloud,
 *     unchanged from before;
 *   - a capture where NO frame carries a capture pose may lift from its solved
 *     cameras, but only through an alignment that verified, whose residual
 *     clears {@link MAX_ALIGN_RESIDUAL_M}, and whose `determined` block says it
 *     pinned down all four of size, up, heading and origin — and only with the
 *     cloud carried through that same transform first;
 *   - missing, unverified, too-loose, or size-only alignment is an honest
 *     'no-pose', as it always was. Nothing is placed on a frame this stage
 *     cannot name in metres AND locate in the Place.
 *
 * That last clause is not belt-and-braces. `SplatAlignManifest.determined`
 * exists because a `'known-distance'` frame ships a full 4x4 whose heading and
 * origin are whatever the camera solve happened to choose, and its own doc
 * requires a consumer that places one scan beside another to check them first.
 * `thing_match` fusing these positions across scans is exactly that.
 *
 * The no-capture-pose test is per CAPTURE, not per frame, and that is
 * load-bearing rather than caution. The camera and the cloud have to be in one
 * space. A capture that tracked accumulated its cloud in the tracker's frame;
 * a capture that did not tracked nothing, and its `<base>.glb` was built from
 * the solver's own seed cloud in the run that wrote the poses
 * (server/colmap/colmap_poses.ts:606-651), so cloud and cameras share a frame
 * by construction. Pairing one solved camera against a tracker-frame cloud
 * would be the original error in a new place — so a single posed frame
 * anywhere in the capture keeps the whole capture on the capture-pose pairing.
 *
 * ── Why the cloud is read through the node hierarchy ─────────────────────────
 *
 * Measured, not assumed. In the raw autosave GLB the `point-cloud` node and
 * both its ancestors are identity, so reading POSITION straight out happens to
 * work. In an OPTIMIZED scan it does not: `quantize()` puts the dequantization
 * on the node, and in `1787789921923_home-00-studio-a.opt.glb` the
 * `point-cloud` node carries scale 2.470 and translation (0, 1.300, 0). Reading
 * raw there would place every point 2.47x out from the origin, silently and
 * plausibly. Applying the accumulated world matrix costs nothing and removes
 * the whole class of error.
 *
 * ── What frame `worldPos` is in, and how a viewer gets out of it ─────────────
 *
 * ONE frame, stated once: **`worldPos` is always in the project's metric
 * frame — real metres.** That is not a preference, it is forced. Every position
 * this stage writes converges at `detectionLikesForWorld`, and `thing_match`
 * fuses those across scans inside `THING_MATCH_RADIUS_M` (0.75 m). A radius in
 * metres compared against numbers that are not metres is not "approximate", it
 * is meaningless — and it fails by MERGING two different objects or SPLITTING
 * one, both of which look like a plausible answer. So the unit is fixed at the
 * consumer, and the producer has to meet it.
 *
 * For an ordinary tracked capture that costs nothing: the tracker's frame is
 * already metric, the cloud was accumulated in it, and `worldPos` lands in the
 * scan GLB's own frame as it always did.
 *
 * A capture lifted from solved cameras is the case where the two frames come
 * apart. Its `<base>.glb` holds the solver's seed cloud in solver units, and
 * the rays are cast against `transformCloud(cloud, projectTransform)` — so
 * `worldPos` is metres, and the untouched GLB beside it is not. A viewer
 * drawing a marker at those coordinates inside the GLB's frame puts it
 * somewhere the object is not: with the measured 0.4798 m/unit solve, four
 * times too close to the origin and offset by the whole alignment translation.
 *
 * The alternative — writing `worldPos` back in the cloud's frame so a viewer
 * could use it verbatim — was rejected, and the reason is the paragraph above.
 * It would hand `thing_match` solver units at a metre radius. Rescuing that
 * would mean every consumer multiplying by a scale before comparing, i.e. the
 * unit conversion scattered across the system instead of resolved here, and
 * the first consumer to forget it fails silently.
 *
 * So the frame is declared instead of moved. `metricFrame` is present in the
 * sidecar EXACTLY when `worldPos`'s frame differs from the scan GLB's own
 * frame, and it carries `toScanFrame`: the row-major 4x4 that maps a `worldPos`
 * back into the GLB's frame. Absent means the two frames are the same. A
 * consumer that measures distances (thing_match) reads `worldPos` verbatim; a
 * consumer that DRAWS inside the GLB (src/viewer/panoptic-layer.ts) applies
 * `toScanFrame` first. The inverse is composed here from the rotation and
 * scale `readMetricFrame` already validated, rather than left to each reader
 * to invert sixteen numbers off disk — a reader that inverts a matrix it did
 * not check is one shear away from a wrong bearing with no symptom.
 *
 * Note what `toScanFrame` does NOT have to undo: the GLB's node hierarchy. The
 * cloud is read through its accumulated world matrices (previous section), so
 * "the GLB's frame" here means glTF scene coordinates — which is exactly the
 * frame the viewer's scan root draws in, that node's scale 2.470 already
 * applied on both sides. The 2.47x error the previous section describes cannot
 * come back in through this door.
 *
 * None of this loosens the refusals above. A size-only frame is still turned
 * away before any of it: a `toScanFrame` derived from an arbitrary heading
 * about an arbitrary origin would draw markers in a perfectly self-consistent
 * place that is not where the objects are.
 */
import { Document, NodeIO, Primitive } from '@gltf-transform/core'
import { resolve } from '@std/path'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
// @ts-ignore — draco3dgltf ships no type declarations
import draco3d from 'draco3dgltf'

import type { PanopticLiftManifest, SplatAlignManifest } from '../../src/world/types.ts'
import { THING_MATCH_RADIUS_M } from '../thing_match.ts'
import {
  liftRemediation,
  liftSegment,
  MAX_DEPTH_M,
  MIN_CLUSTER_POINTS,
  MIN_CONFIDENCE,
  MIN_DEPTH_M,
  type LiftReason,
} from '../../src/shared/panoptic_lift.ts'
import {
  deriveIntrinsics,
  type KeyframeRecord,
  poseToMatrix,
  readJpegDimensions,
  readKeyframes,
  readSolvedCamera,
  readSolvedPoses,
  recordHasPose,
} from '../splat/splat_train_dataset.ts'
import {
  MIN_SEGMENT_PIXELS,
  splitPanopticSegments,
  type RawPanopticFrame,
  type ThingSegment,
} from './panoptic_segments.ts'

export type { PanopticLiftManifest }

/**
 * Manifest schema version — bump when a consumer-visible field changes.
 *
 * 2 added `metricFrame.toScanFrame`. A version-1 sidecar that carries a
 * `metricFrame` at all is one whose `worldPos` is in a frame it never named,
 * so a viewer cannot draw it — see the header. That is a readable distinction
 * precisely because this number moved.
 */
const SCHEMA_VERSION = 2

/**
 * Largest alignment residual, in metres, this stage will place an object
 * through.
 *
 * Derived from `THING_MATCH_RADIUS_M`, not chosen against it from memory: that
 * 0.75 m is the distance inside which `thing_match` decides two sightings are
 * the same object, so it is the entire error budget a lifted position has. An
 * alignment residual is not one segment's bad luck — it is a systematic offset
 * applied to EVERY position the frame produces, on top of whatever the ray and
 * the cluster got wrong. A fifth of the budget is what is allowed to go to the
 * frame, leaving the rest to the geometry that actually varies per segment.
 *
 * This is deliberately tighter than `splat_align`'s own
 * `DEFAULT_MAX_RESIDUAL_M` (0.25 m), and the two are answering different
 * questions. That one asks "do these two camera tracks describe the same
 * physical path at all" and is loose on purpose; this one asks "may objects be
 * placed in this frame", and 0.25 m is a third of the fusion radius — too much
 * of it to hand to a constant offset before a single ray has been cast.
 *
 * Per ADR 0005 rule 5 this is a budget allocation against a known constant,
 * NOT a measured placement-repeatability figure; measuring that would need a
 * ground-truthed capture placed repeatedly, which nothing here has run.
 */
export const MAX_ALIGN_RESIDUAL_M = THING_MATCH_RADIUS_M / 5

// ─── The metric frame ────────────────────────────────────────────────────────
//
// Everything below is the ONE place coupled to `SplatAlignManifest`'s field
// names. A shape change upstream lands here and nowhere else in this file:
// the rest of the stage only ever sees a `MetricFrame`.

/** A verified alignment, reduced to exactly what lifting needs. */
interface MetricFrame {
  /** Row-major 4x4, solver space → project metres, scale already folded in. */
  transform: number[]
  /** That transform's rotation with the scale divided out, row-major 3x3. */
  rotation: number[][]
  /** Metres per solver unit. */
  scale: number
  /** The measurement that backs the claim (ADR 0005 rule 3). */
  residualM: number
  /** Basename of the sidecar it came from, for the audit trail. */
  source: string
}

/**
 * The frame, or the reason there is none — the caller has to be able to say
 * which of "never aligned", "aligned and refused" and "aligned too loosely"
 * happened, because those are three different next actions for an operator.
 *
 * `next` carries that action with the reason rather than leaving the caller to
 * infer it, because one of these refusals inverts the obvious advice: a frame
 * that fixes size but not heading or origin is exactly what measuring another
 * distance produces, so telling that operator to go and measure would send
 * them back to the same refusal.
 */
type MetricFrameLookup =
  | { frame: MetricFrame }
  | { frame: null; why: string; next: string }

/** The action for every refusal whose fix really is "take a measurement". */
const MEASURE_NEXT =
  'Measure this capture against one known real-world distance to establish that frame, then run object placement again.'

/** A 16-number row-major matrix, or null. Anything else is not a transform. */
function matrix16(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 16) return null
  return value.every((n) => typeof n === 'number' && Number.isFinite(n)) ? value as number[] : null
}

/**
 * The proper rotation inside a similarity's 3x3 block, row-major, or null.
 *
 * `projectTransform` is s·R — splat-align folds the Umeyama scale into the
 * rotation — so dividing by the reported `scale` should leave an orthonormal
 * block. Every part of that is checked rather than assumed, for the reason
 * `memory_push.ts`'s `similarityRotationQuat` checks the same three things:
 * these are sixteen numbers read off disk, and a non-uniform, sheared or
 * reflected block would still happily rotate a ray — into the wrong direction,
 * plausibly, with no symptom. 1e-3 is far tighter than any real skew and far
 * looser than JSON round-tripping of a matrix that was built as s·R.
 */
function similarityRotation(m: number[], scale: number): number[][] | null {
  const r = [
    [m[0] / scale, m[1] / scale, m[2] / scale],
    [m[4] / scale, m[5] / scale, m[6] / scale],
    [m[8] / scale, m[9] / scale, m[10] / scale],
  ]
  for (const row of r) {
    if (Math.abs(Math.hypot(row[0], row[1], row[2]) - 1) > 1e-3) return null
  }
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  if (Math.abs(dot(r[0], r[1])) > 1e-3) return null
  if (Math.abs(dot(r[0], r[2])) > 1e-3) return null
  if (Math.abs(dot(r[1], r[2])) > 1e-3) return null
  const det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
    r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
    r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0])
  // A reflection maps a right-handed camera basis to a left-handed one, which
  // silently mirrors every ray. No such transform is a rigid motion.
  if (!(det > 0)) return null
  return r
}

/**
 * Read the session's metric alignment, if it has one that may be trusted.
 *
 * Both paths `splat_align.ts:defaultManifestPath` writes to are tried, in its
 * own preference order: beside the splat/scan when there was one, else in the
 * session dir where the inputs live.
 *
 * `status === 'ok'` already encodes the aligner's own gates — enough
 * correspondences, a non-degenerate camera path, a residual inside the limit
 * it ran with — so those are not re-litigated here. What IS added is the
 * placement-specific bar {@link MAX_ALIGN_RESIDUAL_M}, which is tighter than
 * the loosest residual an 'ok' can carry, plus the shape checks any sixteen
 * numbers off disk need before they steer a ray.
 */
export async function readMetricFrame(sessionDir: string, glbBase: string): Promise<MetricFrameLookup> {
  let align: SplatAlignManifest | null = null
  let source = ''
  for (const path of [`${glbBase}.splat-align.manifest.json`, `${sessionDir}/splat-align.manifest.json`]) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await Deno.readTextFile(path))
    } catch {
      continue
    }
    // `typeof [] === 'object'`, so an array would sail through and read as a
    // manifest whose every field is undefined — the same trap `readManifest`
    // in memory_push.ts guards.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      align = parsed as SplatAlignManifest
      source = path.split('/').pop() ?? path
      break
    }
  }
  if (!align) {
    return { frame: null, why: 'nothing has measured this capture against a real-world distance yet', next: MEASURE_NEXT }
  }
  if (align.status !== 'ok') {
    return {
      frame: null,
      why: `the measurement of this capture did not verify (${align.skippedReason ?? align.status})`,
      next: MEASURE_NEXT,
    }
  }
  // `determined` says which of the similarity's seven degrees of freedom the
  // fit actually pinned down, and `SplatAlignManifest`'s own note on it
  // (src/world/manifests.ts:342-355) is prescriptive: "a consumer that places
  // one scan beside another must check `heading` and `origin` here first — a
  // scale-only frame is exactly as arbitrary in those axes as no frame at all".
  // This stage IS that consumer. Every position it writes converges at
  // `detectionLikesForWorld`, and `thing_match` then fuses those across scans
  // at THING_MATCH_RADIUS_M. A `'known-distance'` frame states a SIZE and not a
  // placement — splat_align.ts publishes `heading: false, origin: false` on it
  // deliberately — so carrying a camera through one would put objects in real
  // metres at an arbitrary bearing about an arbitrary origin. That is the
  // confidently-wrong answer this whole gate exists to refuse, and it is worse
  // than the honest 'no-pose' because every number in it looks right.
  //
  // Absent reads as all four determined, and only for `'umeyama'`: that is
  // exactly what the field's doc says an older manifest is. The
  // `'known-distance'` driver always writes the block, so one without it is
  // malformed rather than old.
  const determined = align.determined ??
    (align.tool === 'known-distance' ? null : { scale: true, up: true, heading: true, origin: true })
  if (!determined) {
    return {
      frame: null,
      why: 'the measurement never recorded what it pinned down, so it cannot be trusted to place anything',
      next: MEASURE_NEXT,
    }
  }
  if (!determined.scale || !determined.up || !determined.heading || !determined.origin) {
    const missing = [
      determined.scale ? null : 'how big it is',
      determined.up ? null : 'which way is up',
      determined.heading ? null : 'which way it faces',
      determined.origin ? null : 'where it sits',
    ].filter((s): s is string => s !== null)
    return {
      frame: null,
      why: `the measurement does not fix ${missing.join(' or ')}, so anything placed in it could not be matched ` +
        'against the rest of this Place',
      // NOT "go and measure a distance": a measured distance is what produced
      // this frame, and another one would produce the same one again. What is
      // missing is where the capture sits in the Place, which is the World
      // Editor's two-point flow (server/capture/known_distance.ts:31-38).
      next: 'Place this capture in the room in the World Editor — mark two points on it whose real positions are ' +
        'known — then run object placement again.',
    }
  }
  const scale = align.scale
  if (typeof scale !== 'number' || !Number.isFinite(scale) || !(scale > 0)) {
    return { frame: null, why: 'the measurement records no usable metres-per-unit', next: MEASURE_NEXT }
  }
  const residualM = align.residualM
  // No residual means it never reported how wrong it is. That is not a pass.
  if (typeof residualM !== 'number' || !Number.isFinite(residualM)) {
    return {
      frame: null,
      why: 'the measurement never reported how far off it is, so it cannot be trusted to place anything',
      next: MEASURE_NEXT,
    }
  }
  if (!(residualM <= MAX_ALIGN_RESIDUAL_M)) {
    return {
      frame: null,
      why: `the measurement is off by ${residualM.toFixed(3)} m, over the ${MAX_ALIGN_RESIDUAL_M.toFixed(2)} m this stage will place through`,
      next: 'Measure this capture against a known real-world distance again, more carefully, then run object placement again.',
    }
  }
  const transform = matrix16(align.projectTransform)
  if (!transform) return { frame: null, why: 'the measurement carries no usable transform', next: MEASURE_NEXT }
  const rotation = similarityRotation(transform, scale)
  if (!rotation) {
    return {
      frame: null,
      why: 'the measurement\'s transform is not a uniform scale times a rotation',
      next: MEASURE_NEXT,
    }
  }
  return { frame: { transform, rotation, scale, residualM, source } }
}

/** Row-major 4x4 applied to a point. */
function applyRowMajor(m: number[], x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ]
}

/**
 * The cloud, carried out of solver units into project metres.
 *
 * The cloud moves, not the thresholds: MIN_DEPTH_M / MAX_DEPTH_M /
 * MAX_CLUSTER_SPREAD_M are all metres, and so is the `depthM` the sidecar
 * reports. Scaling the cloud once here keeps every one of those meaning what
 * its name says, instead of scattering a unit conversion through the policy
 * module — which is also why `params` in the manifest still reads in metres.
 */
function transformCloud(
  cloud: { positions: Float32Array; count: number },
  m: number[],
): { positions: Float32Array; count: number } {
  const out = new Float32Array(cloud.count * 3)
  for (let i = 0; i < cloud.count; i++) {
    const p = applyRowMajor(m, cloud.positions[i * 3], cloud.positions[i * 3 + 1], cloud.positions[i * 3 + 2])
    out[i * 3] = p[0]
    out[i * 3 + 1] = p[1]
    out[i * 3 + 2] = p[2]
  }
  return { positions: out, count: cloud.count }
}

/**
 * The map BACK: a point in project metres → the scan GLB's own frame.
 *
 * Row-major 4x4, published as `metricFrame.toScanFrame` so a consumer drawing
 * inside the GLB has the one thing it cannot safely derive for itself.
 *
 * Composed, not inverted numerically. `frame.transform` is s·R with a
 * translation, and `readMetricFrame` has already proved the R part orthonormal
 * and right-handed and the s part finite and positive — so the exact inverse is
 * (1/s)·Rᵀ applied to (q - t), with no conditioning to worry about and no way
 * for a near-singular general inverse to return something plausible. A reader
 * running a general 4x4 inversion on numbers it had not checked would get the
 * same answer here and a quietly wrong one on a malformed manifest.
 */
function inverseSimilarity(frame: MetricFrame): number[] {
  const inv = 1 / frame.scale
  const r = frame.rotation
  const t = [frame.transform[3], frame.transform[7], frame.transform[11]]
  // (1/s)·Rᵀ — row i of the inverse's 3x3 is column i of R, scaled.
  const a = [
    [inv * r[0][0], inv * r[1][0], inv * r[2][0]],
    [inv * r[0][1], inv * r[1][1], inv * r[2][1]],
    [inv * r[0][2], inv * r[1][2], inv * r[2][2]],
  ]
  const shift = a.map((row) => -(row[0] * t[0] + row[1] * t[1] + row[2] * t[2]))
  return [
    a[0][0], a[0][1], a[0][2], shift[0],
    a[1][0], a[1][1], a[1][2], shift[1],
    a[2][0], a[2][1], a[2][2], shift[2],
    0, 0, 0, 1,
  ]
}

/**
 * A solved camera-to-world, re-expressed as a RIGID camera-to-project matrix.
 *
 * The alignment's scale belongs on the translation and nowhere else. Its 3x3
 * block is s·R, and leaving the s on the camera basis would both scale the
 * unit ray `cameraRay` builds (harmless, it renormalises) and blow past
 * `decomposeCamera`'s basis-length sanity check for any scale outside
 * (0.5, 2.0) — the measured 0.4798 m/unit solve is already outside it. So the
 * rotation is composed scale-free and only the camera centre goes through the
 * full transform.
 */
function solvedCameraInProject(c2w: number[][] | undefined, frame: MetricFrame): number[][] | null {
  if (!c2w || c2w.length < 3) return null
  for (let i = 0; i < 3; i++) {
    if (!Array.isArray(c2w[i]) || c2w[i].length < 4 || !c2w[i].slice(0, 4).every((v) => Number.isFinite(v))) return null
  }
  const centre = applyRowMajor(frame.transform, c2w[0][3], c2w[1][3], c2w[2][3])
  const out: number[][] = []
  for (let r = 0; r < 3; r++) {
    const row: number[] = []
    for (let c = 0; c < 3; c++) {
      row.push(frame.rotation[r][0] * c2w[0][c] + frame.rotation[r][1] * c2w[1][c] + frame.rotation[r][2] * c2w[2][c])
    }
    row.push(centre[r])
    out.push(row)
  }
  out.push([0, 0, 0, 1])
  return out
}

/**
 * One lifted (or deliberately unlifted) segment.
 *
 * A record with `worldPos: null` is written just as faithfully as one with a
 * position — that is the audit trail, and it is what makes "44 objects were
 * seen and could not be placed" a readable fact rather than silence.
 * `detectionsFromMeta` (server/main.ts:2860) already skips any entry whose
 * worldPos is not three finite numbers, so a null-position record cannot become
 * a Thing by an existing rule rather than a new one.
 */
export interface PanopticDetectionRecord {
  /** Same field names as StoredDetectionMeta, so the aggregator needs no shim. */
  label: string
  confidence: number | null
  worldPos: { x: number; y: number; z: number } | null
  /** Present exactly when worldPos is null. */
  reason?: LiftReason
  /** Keyframe this segment came from. */
  file: string
  /** Index within that frame's thing segments — the stable half of targetId. */
  segmentIndex: number
  /** The segmenter's own mean softmax, kept distinct from `confidence`. */
  segScore: number
  areaPx: number
  centroidPx: [number, number]
  /** Depth along the ray, metres. Present whenever a cluster was found. */
  depthM?: number
  /** Diagnostics that explain the verdict without a re-run. */
  conePoints?: number
  clusterPoints?: number
  spreadM?: number
  /**
   * Nearest in-cone hit with the depth window removed, metres along the ray.
   * Present only on an 'out-of-range' record, which is the only case where the
   * window rather than the cloud is what rejected the segment.
   */
  nearestDepthM?: number
  /**
   * Where this record's camera came from. Absent means the capture's own
   * tracker, which is the ordinary case; 'solved' means a reconstructed camera
   * carried through the sidecar's `metricFrame` — see the header. A reader who
   * wants to know why one capture's positions are more or less trustworthy
   * than another's should not have to infer it from the session's file list.
   */
  cameraSource?: 'solved'
}

export interface PanopticDetectionsSidecar {
  schemaVersion: number
  source: 'panoptic-lift'
  sessionId?: string
  scanId?: string
  generatedAt: string
  /**
   * The verified alignment that put this capture in metres, when the lift
   * needed one. Present exactly when some record carries `cameraSource:
   * 'solved'`, and it is what makes those positions auditable: the same
   * transform, applied again, has to reproduce them.
   *
   * It is also the frame declaration every reader of `worldPos` depends on —
   * see the header. Present means `worldPos` is NOT in the scan GLB's frame,
   * and `toScanFrame` is the way back into it; absent means the two frames are
   * the same. Either way `worldPos` itself is metres.
   */
  metricFrame?: {
    source: string
    scale: number
    residualM: number
    /** Row-major 4x4: a `worldPos` → the scan GLB's own frame. */
    toScanFrame: number[]
  }
  detections: PanopticDetectionRecord[]
}

export interface PanopticLiftRunOptions {
  /** Absolute path to the session dir holding keyframes + the segments file. */
  sessionDir: string
  /** Absolute path to the scan GLB whose cloud the rays hit. */
  scanGlbPath: string
  /** Where the detections sidecar lands. Defaults beside the GLB. */
  detectionsPath?: string
  /** Where the manifest lands. Defaults beside the detections sidecar. */
  manifestPath?: string
  /** Segments file. Defaults to `<sessionDir>/panoptic.segments.json`. */
  segmentsPath?: string
  /** Smallest mask kept, in source pixels. Defaults to the scan stage's value. */
  minSegmentPixels?: number
  sessionId?: string
  scanId?: string
  /**
   * Test seam — supply the cloud directly instead of decoding a GLB, the same
   * shape `_spawn` plays in panoptic_scan.ts and splat_detect.ts. Returning
   * null means "the cloud could not be read", which is a skip, not an error.
   */
  _readCloud?: (path: string) => Promise<{ positions: Float32Array; count: number } | null>
}

// IO is expensive to initialise, so once per process — the same per-module
// singleton `server/lingbot-map/lingbot_map_glb.ts:37` uses. `pipeline.ts`'s
// equivalent is not exported, and this stage only ever READS, so it registers
// the decoder half and nothing else.
let ioPromise: Promise<NodeIO> | null = null

function getIO(): Promise<NodeIO> {
  ioPromise ??= (async () => {
    const decoder = await draco3d.createDecoderModule({})
    // ALL_EXTENSIONS, not a hand-picked subset: glTF-Transform silently drops
    // any extension the IO has not registered at read time, and a scan that
    // went through `optimizeScan` carries KHR_mesh_quantization on the very
    // accessor this stage reads.
    return new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'draco3d.decoder': decoder })
  })()
  return ioPromise
}

/** Multiply a row-major 4x4 by another. */
function mul4(a: number[][], b: number[][]): number[][] {
  const out: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[r][k] * b[k][c]
      out[r][c] = s
    }
  }
  return out
}

/** glTF node matrices are COLUMN-major 16-arrays; this repo works row-major. */
function nodeMatrixRowMajor(m: readonly number[]): number[][] {
  return [
    [m[0], m[4], m[8], m[12]],
    [m[1], m[5], m[9], m[13]],
    [m[2], m[6], m[10], m[14]],
    [m[3], m[7], m[11], m[15]],
  ]
}

const IDENTITY_4: number[][] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]

/**
 * Every POINTS position in the document, in world space.
 *
 * Walks the scene graph rather than `listMeshes()` so the accumulated node
 * transform is applied — see the header for the measured .opt.glb case where
 * skipping it scales the whole cloud by 2.47. Line-strip primitives (the
 * `camera-path` node) and triangle meshes (floor plane, detection boxes) are
 * skipped: a detection box is an OUTPUT of a previous stage, and letting it
 * back in as "surface geometry" would let this stage confirm its own guesses.
 */
export function collectPointPositions(doc: Document): { positions: Float32Array; count: number } {
  const xyz: number[] = []
  const walk = (node: ReturnType<Document['createNode']>, parent: number[][]): void => {
    const world = mul4(parent, nodeMatrixRowMajor(node.getMatrix()))
    const mesh = node.getMesh()
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== Primitive.Mode.POINTS) continue
        const acc = prim.getAttribute('POSITION')
        if (!acc) continue
        const n = acc.getCount()
        const el = [0, 0, 0]
        for (let i = 0; i < n; i++) {
          // getElement, not getArray: it denormalises an integer-quantized
          // accessor for us. getArray on a KHR_mesh_quantization POSITION
          // returns raw int16s.
          acc.getElement(i, el)
          xyz.push(
            world[0][0] * el[0] + world[0][1] * el[1] + world[0][2] * el[2] + world[0][3],
            world[1][0] * el[0] + world[1][1] * el[1] + world[1][2] * el[2] + world[1][3],
            world[2][0] * el[0] + world[2][1] * el[1] + world[2][2] * el[2] + world[2][3],
          )
        }
      }
    }
    for (const child of node.listChildren()) walk(child, world)
  }
  for (const scene of doc.getRoot().listScenes()) {
    for (const node of scene.listChildren()) walk(node, IDENTITY_4)
  }
  return { positions: new Float32Array(xyz), count: xyz.length / 3 }
}

async function readCloudFromGlb(path: string): Promise<{ positions: Float32Array; count: number } | null> {
  try {
    const io = await getIO()
    const doc = await io.readBinary(await Deno.readFile(path))
    return collectPointPositions(doc)
  } catch {
    // A missing or undecodable GLB is a precondition failure, reported as a
    // skip with a remediation upstream — never a server crash.
    return null
  }
}

async function finish(
  manifestPath: string,
  manifest: PanopticLiftManifest,
  elapsedMs: number,
): Promise<PanopticLiftManifest> {
  const full = { ...manifest, timing: { elapsedMs } }
  try {
    await Deno.writeTextFile(manifestPath, JSON.stringify(full, null, 2))
  } catch {
    // A manifest we cannot persist must not turn a completed run into a crash;
    // the returned value is still the job's result. Same rule as panoptic_scan.
  }
  return full
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Lift every thing segment in a session against a scan's point cloud.
 *
 * Never throws. Every unmet precondition is a `skipped` with a remediation,
 * matching the contract `server/colmap/colmap_poses.ts:132` and
 * `server/splat/splat_train.ts:168` set for optional tooling — a lift with no
 * segments file is exactly as "not configured" as a missing Brush binary.
 */
export async function runPanopticLift(opts: PanopticLiftRunOptions): Promise<PanopticLiftManifest> {
  const started = Date.now()
  // Resolved here rather than trusted from the caller, for the reason
  // splat_train_dataset.ts:158 now does the same: SCANS_DIR defaults to
  // './scans', so every path the WorldJob runner hands a stage is relative.
  // That cost the splat pipeline every run it ever attempted — a relative
  // symlink target resolved against the link's own directory, and Brush saw an
  // empty dataset. Nothing here writes symlinks, but the sidecar paths below
  // are derived from these and land next to the GLB, so the same class of
  // silent misplacement applies. Callers stay free to pass relative paths.
  const sessionDir = resolve(opts.sessionDir)
  const scanGlbPath = resolve(opts.scanGlbPath)
  const minSegmentPixels = opts.minSegmentPixels ?? MIN_SEGMENT_PIXELS
  const segmentsPath = opts.segmentsPath ? resolve(opts.segmentsPath) : `${sessionDir}/panoptic.segments.json`
  const glbBase = scanGlbPath.replace(/\.glb$/, '')
  const detectionsPath = opts.detectionsPath ?? `${glbBase}.panoptic.detections.json`
  const manifestPath = opts.manifestPath ?? `${glbBase}.panoptic-lift.manifest.json`

  const base: PanopticLiftManifest = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'panoptic-lift',
    status: 'skipped',
    createdAt: new Date().toISOString(),
    sessionDir: sessionDir,
    params: {
      minSegmentPixels,
      minConfidence: MIN_CONFIDENCE,
      minDepthM: MIN_DEPTH_M,
      maxDepthM: MAX_DEPTH_M,
      minClusterPoints: MIN_CLUSTER_POINTS,
    },
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.scanId ? { scanId: opts.scanId } : {}),
  }

  // 1. Segments. Their absence means panoptic-scan has not run (or was itself
  //    skipped for a missing venv), which is a precondition, not a failure.
  let payload: { frames?: RawPanopticFrame[] }
  try {
    payload = JSON.parse(await Deno.readTextFile(segmentsPath)) as typeof payload
  } catch {
    return finish(manifestPath, {
      ...base,
      skippedReason: `no readable panoptic segments at ${segmentsPath}`,
      remediation: 'Run a panoptic-scan job on this session first (see docs/pipelines/panoptic-scan.md).',
    }, Date.now() - started)
  }

  // splitPanopticSegments stays the SOLE thing/stuff filter, including its
  // deliberate unknown-counts-as-stuff asymmetry (panoptic_segments.ts:93-102).
  // A second label table here would be exactly the duplicated taxonomy that
  // module exists to prevent.
  const split = splitPanopticSegments(payload.frames ?? [], minSegmentPixels)
  if (split.things.length === 0) {
    return finish(manifestPath, {
      ...base,
      status: 'ok',
      segmentCount: 0,
      confidentCount: 0,
      lowConfidenceCount: 0,
      undeterminedCount: 0,
      reasons: {},
      // Deliberately 'ok' rather than 'skipped': the segmenter ran and found no
      // discrete objects. That is an answer about the room. It is also what a
      // run with no thing-label list produces — which is why panoptic-scan's
      // manifest carries `thingLabelsUsed`; check that before reading this as
      // an empty room.
    }, Date.now() - started)
  }

  // 2. The cloud.
  const readCloud = opts._readCloud ?? readCloudFromGlb
  const cloud = await readCloud(scanGlbPath)
  if (!cloud || cloud.count === 0) {
    return finish(manifestPath, {
      ...base,
      segmentCount: split.things.length,
      pointCount: cloud?.count ?? 0,
      skippedReason: `no point cloud in ${scanGlbPath.split('/').pop()}`,
      remediation: 'Lifting needs the scan\'s accumulated points; re-capture with room scanning enabled, or run a colmap-poses job to produce a sparse cloud.',
    }, Date.now() - started)
  }

  // 3. Poses + the pixel frame the centroids are in. Both keyed on `file`,
  //    which is the join the worker and the streamer already agree on.
  const records = new Map<string, KeyframeRecord>()
  for (const rec of await readKeyframes(sessionDir)) {
    if (typeof rec.file === 'string') records.set(rec.file, rec)
  }

  // Image dimensions come from the JPEG's own SOF marker, not from the
  // record's `intrinsics.width/height`: the phone downscales frames and the
  // recorded size drifts from what landed on disk. `deriveIntrinsics` already
  // owns the rescale between the two, and the worker's centroids are in the
  // ACTUAL pixels (post_process_panoptic_segmentation is given
  // (image.height, image.width) as its target size).
  const dims = new Map<string, { w: number; h: number } | null>()
  const dimsFor = async (file: string): Promise<{ w: number; h: number } | null> => {
    if (dims.has(file)) return dims.get(file)!
    let out: { w: number; h: number } | null = null
    try {
      out = readJpegDimensions(await Deno.readFile(`${sessionDir}/${file}`))
    } catch {
      out = null
    }
    dims.set(file, out)
    return out
  }

  // 3b. The camera source for this capture, decided once — see the header's
  //     rule. A single tracked frame anywhere means the cloud is in the
  //     tracker's frame, so solved cameras are off the table for the whole
  //     capture; only a capture that tracked nothing can reach the alignment
  //     path, and only if the alignment verified.
  const solved = [...records.values()].some(recordHasPose) ? null : await readSolvedPoses(sessionDir)
  let metric: MetricFrame | null = null
  let metricRefusal: { why: string; next: string } | undefined
  let rayCloud = cloud
  if (solved) {
    const lookup = await readMetricFrame(sessionDir, glbBase)
    if (lookup.frame) {
      metric = lookup.frame
      rayCloud = transformCloud(cloud, lookup.frame.transform)
    } else {
      metricRefusal = { why: lookup.why, next: lookup.next }
    }
  }
  // COLMAP fits f, cx, cy to the images it actually solved, which beats
  // deriveIntrinsics' 55-degree default for a capture whose keyframes.jsonl
  // records carry no intrinsics at all — the measured state of both
  // video-ingest sessions on disk. `deriveIntrinsics` still owns the rescale
  // to the JPEG's real pixels, so this is one more source for it, not a second
  // lens path (ADR 0001).
  const solvedCamera = metric ? await readSolvedCamera(sessionDir) : null

  // 4. Lift, counting per frame so segmentIndex is stable across re-runs:
  //    splitPanopticSegments preserves the worker's order, and the worker walks
  //    `segments_info` in a fixed order for a given segments file. That makes
  //    `<scanId>:panoptic:<file>:<index>` a natural key thing_match can update
  //    rather than duplicate (server/thing_match.ts:52-54).
  const perFrame = new Map<string, number>()
  const out: PanopticDetectionRecord[] = []
  const reasons: Record<string, number> = {}
  const confidences: number[] = []
  let lowConfidence = 0

  for (const seg of split.things as ThingSegment[]) {
    const segmentIndex = perFrame.get(seg.file) ?? 0
    perFrame.set(seg.file, segmentIndex + 1)

    const record: PanopticDetectionRecord = {
      label: seg.label,
      confidence: null,
      worldPos: null,
      file: seg.file,
      segmentIndex,
      segScore: seg.score,
      areaPx: seg.areaPx,
      centroidPx: seg.centroidPx,
    }

    const rec = records.get(seg.file)
    const size = await dimsFor(seg.file)
    // The capture's own tracker first, then — only when this capture has a
    // verified metric frame — its solved camera carried into that frame.
    const cameraToWorld = rec && recordHasPose(rec)
      ? poseToMatrix(rec.pose ?? {})
      : metric
      ? solvedCameraInProject(solved?.get(seg.file), metric)
      : null
    if (!cameraToWorld || !size) {
      // A join failure, not a geometry verdict — `liftSegment` never produces
      // this — but it shares the reason field so a reader of the sidecar has
      // one list of reasons to consult rather than two.
      record.reason = 'no-pose'
      reasons['no-pose'] = (reasons['no-pose'] ?? 0) + 1
      out.push(record)
      continue
    }
    const fromSolved = !(rec && recordHasPose(rec))
    if (fromSolved) record.cameraSource = 'solved'

    const intr = deriveIntrinsics(
      (fromSolved ? solvedCamera : null) ?? rec?.intrinsics ?? {},
      size.w,
      size.h,
    )
    const result = liftSegment(
      {
        camera: {
          cameraToWorld,
          flX: intr.flX,
          flY: intr.flY,
          cx: intr.cx,
          cy: intr.cy,
        },
        centroidPx: seg.centroidPx,
        areaPx: seg.areaPx,
        segScore: seg.score,
        // Both optional and both passed straight through: a segments file
        // written before the worker emitted them still lifts, just with the
        // area-derived footprint and no centroid check.
        ...(seg.bboxPx ? { bboxPx: seg.bboxPx } : {}),
        ...(seg.centroidOnMask !== undefined ? { centroidOnMask: seg.centroidOnMask } : {}),
      },
      rayCloud.positions,
      rayCloud.count,
    )

    if (result.debug.conePoints > 0) record.conePoints = result.debug.conePoints
    if (result.debug.clusterPoints > 0) record.clusterPoints = result.debug.clusterPoints
    if (result.debug.depthM !== null) record.depthM = result.debug.depthM
    if (result.debug.spreadM !== null) record.spreadM = result.debug.spreadM
    if (result.debug.nearestDepthM !== null) record.nearestDepthM = result.debug.nearestDepthM

    if (result.worldPos && result.confidence !== null) {
      record.worldPos = result.worldPos
      record.confidence = result.confidence
      confidences.push(result.confidence)
    } else {
      record.reason = result.reason
      reasons[result.reason ?? 'unknown'] = (reasons[result.reason ?? 'unknown'] ?? 0) + 1
      if (result.reason === 'low-confidence') lowConfidence++
    }
    out.push(record)
  }

  // 5. Write the sidecar. A whole-file overwrite, so a re-lift is idempotent.
  const sidecar: PanopticDetectionsSidecar = {
    schemaVersion: SCHEMA_VERSION,
    source: 'panoptic-lift',
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.scanId ? { scanId: opts.scanId } : {}),
    generatedAt: new Date().toISOString(),
    // Keyed off a record that actually used it, not off the frame having been
    // read. A capture can clear every alignment gate and still lift nothing
    // from a solved camera — the solve may simply carry none of these
    // keyframes — and a sidecar that advertised an alignment behind zero
    // positions would be claiming provenance for work that never happened.
    ...(metric && out.some((record) => record.cameraSource === 'solved')
      ? {
        metricFrame: {
          source: metric.source,
          scale: metric.scale,
          residualM: metric.residualM,
          // The frame declaration, not decoration: without it a viewer has
          // metric coordinates and no way to know they are not the GLB's.
          toScanFrame: inverseSimilarity(metric),
        },
      }
      : {}),
    detections: out,
  }
  try {
    await Deno.writeTextFile(detectionsPath, JSON.stringify(sidecar, null, 2))
  } catch (e) {
    return finish(manifestPath, {
      ...base,
      status: 'error',
      segmentCount: split.things.length,
      pointCount: cloud.count,
      error: `lift completed but could not write ${detectionsPath}: ${e instanceof Error ? e.message : String(e)}`,
    }, Date.now() - started)
  }

  // 6. A run that placed nothing is still `ok` — the segmenter ran, the rays
  //    were cast, and every abstention is recorded. But "0 of 29" plus a reason
  //    tally is a diagnosis the reader has to make, and the two real runs
  //    measured on this repo's sessions looked identical at that level while
  //    needing entirely different fixes (no capture pose vs a non-metric
  //    cloud). So the dominant reason picks a sentence. Only when NOTHING was
  //    placed — see `liftRemediation`.
  //
  //    `readSolvedPoses` is consulted only in that case, and only to tell the
  //    two no-pose situations apart: "this session has SfM poses that are
  //    deliberately not used" is a different instruction to an operator than
  //    "nothing solved this session at all". It is the same reader the splat
  //    dataset builder already uses, not a second pose-file format (ADR 0001).
  //
  //    One case liftRemediation cannot diagnose, because it is about a file
  //    outside this session's own inputs: a capture that HAS a solved camera
  //    track and was refused the metric frame that would let it be used. That
  //    is not "re-capture with tracking on" — the capture is fine and the
  //    missing piece is one measurement — so it gets its own sentence.
  let remediation: string | undefined
  if (confidences.length === 0) {
    const hasSolvedPoses = reasons['no-pose'] ? solved !== null || (await readSolvedPoses(sessionDir)) !== null : false
    remediation = liftRemediation(reasons, { hasSolvedPoses })
    if (metricRefusal && reasons['no-pose']) {
      // The next action comes from the refusal itself, not from this sentence.
      // One of them inverts the obvious advice — a frame that fixed size but
      // not heading or origin is what measuring another distance produces — so
      // a fixed "go and measure" tail here would send that operator straight
      // back to the same refusal.
      remediation = 'No frame carries a camera position from the capture itself. This capture does have a ' +
        'reconstructed camera track, but nothing in a reconstruction fixes real-world scale, or where the room ' +
        `sits, so it can place objects only once a verified frame does — ${metricRefusal.why}. ${metricRefusal.next}`
    }
  }

  return finish(manifestPath, {
    ...base,
    status: 'ok',
    segmentCount: split.things.length,
    confidentCount: confidences.length,
    lowConfidenceCount: lowConfidence,
    undeterminedCount: split.things.length - confidences.length,
    reasons,
    ...(confidences.length > 0 ? { medianConfidence: median(confidences)! } : {}),
    pointCount: cloud.count,
    detectionsPath: detectionsPath.split('/').pop() ?? detectionsPath,
    cloudSource: scanGlbPath.split('/').pop() ?? scanGlbPath,
    ...(remediation ? { remediation } : {}),
  }, Date.now() - started)
}
