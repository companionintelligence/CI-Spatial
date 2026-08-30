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
 * ── Why solved poses are NOT used as a fallback here ─────────────────────────
 *
 * `buildBrushDataset` falls back from a capture pose to `readSolvedPoses`
 * (COLMAP / LingBot-Map) per frame. That is right for a trainer, which only
 * needs cameras consistent with each other, and wrong here. Monocular SfM
 * reconstructs only up to an unknown scale, at an arbitrary origin and heading
 * — the reason `SplatAlignManifest` exists at all (src/world/manifests.ts). A
 * position lifted from a COLMAP pose against the capture-frame scan cloud is
 * not merely imprecise, it is in a different space and a different unit, and
 * `thing_match` would fuse it against real metres at a 0.75 m radius. So the
 * pairing is fixed: capture poses with the scan's own cloud, and a frame with
 * no capture pose is an honest 'no-pose', not a guess.
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
 */
import { Document, NodeIO, Primitive } from '@gltf-transform/core'
import { resolve } from '@std/path'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
// @ts-ignore — draco3dgltf ships no type declarations
import draco3d from 'draco3dgltf'

import type { PanopticLiftManifest } from '../../src/world/types.ts'
import {
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
  recordHasPose,
} from '../splat/splat_train_dataset.ts'
import {
  MIN_SEGMENT_PIXELS,
  splitPanopticSegments,
  type RawPanopticFrame,
  type ThingSegment,
} from './panoptic_segments.ts'

export type { PanopticLiftManifest }

/** Manifest schema version — bump when a consumer-visible field changes. */
const SCHEMA_VERSION = 1

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
}

export interface PanopticDetectionsSidecar {
  schemaVersion: number
  source: 'panoptic-lift'
  sessionId?: string
  scanId?: string
  generatedAt: string
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
    if (!rec || !recordHasPose(rec) || !size) {
      // A join failure, not a geometry verdict — `liftSegment` never produces
      // this — but it shares the reason field so a reader of the sidecar has
      // one list of reasons to consult rather than two.
      record.reason = 'no-pose'
      reasons['no-pose'] = (reasons['no-pose'] ?? 0) + 1
      out.push(record)
      continue
    }

    const intr = deriveIntrinsics(rec.intrinsics ?? {}, size.w, size.h)
    const result = liftSegment(
      {
        camera: {
          cameraToWorld: poseToMatrix(rec.pose ?? {}),
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
      cloud.positions,
      cloud.count,
    )

    if (result.debug.conePoints > 0) record.conePoints = result.debug.conePoints
    if (result.debug.clusterPoints > 0) record.clusterPoints = result.debug.clusterPoints
    if (result.debug.depthM !== null) record.depthM = result.debug.depthM
    if (result.debug.spreadM !== null) record.spreadM = result.debug.spreadM

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
  }, Date.now() - started)
}
