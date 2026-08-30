/**
 * Pipeline-stage manifest envelope + the per-tool manifests that extend it.
 *
 * Every background pipeline stage (splat-train, splat-detect, splat-finish)
 * writes a `<base>.splat-<stage>.manifest.json` sidecar next to a scan (e.g.
 * `<base>.splat-train.manifest.json`). Both the Deno
 * server drivers (splat_train.ts, splat_detect.ts, splat_finish.ts, all at
 * the repo root) and the browser viewer (src/viewer/splat-layer.ts,
 * src/viewer/splat-detect-layer.ts) need the exact same shape.
 *
 * This file — not the three driver .ts files — is the single canonical
 * location for all four interfaces below, specifically so it can be
 * imported (even type-only) from browser code without pulling Deno's
 * runtime API surface into the frontend's type-check graph: `tsc --noEmit`
 * (run by `npm run build`) type-checks a file's *entire* body once it enters
 * the program, `import type` only skips it for bundling/codegen — so a
 * browser file that type-imports straight from splat_train.ts would drag
 * its `Deno.readFile`/`Deno.Command`/etc. calls into a tsconfig.json program
 * that has no `deno.ns` lib (confirmed via `deno check` on the viewer files
 * before this file existed: 30+ "Cannot find name 'Deno'" errors surfaced
 * from splat_train.ts and splat_train_dataset.ts). Keeping these interfaces
 * here — dependency-free, no `Deno.*` references — avoids that entirely.
 *
 * Per ADR 0001: extend PipelineManifestBase rather than declaring another
 * copy of the envelope — see
 * docs/factory/foundation-updates/0005-shared-manifest-envelope.md.
 */

export interface PipelineManifestBase {
  schemaVersion: number
  tool: string
  status: 'ok' | 'skipped' | 'error'
  createdAt: string
  timing?: { elapsedMs: number }
  skippedReason?: string
  remediation?: string
  error?: string
  sessionId?: string
  scanId?: string
}

/**
 * Torch backend a Python worker can be *asked* for.
 *
 * Defined here, not in either driver, because server/panoptic/panoptic_scan.ts
 * and server/lingbot-map/lingbot_map.ts resolve the same option against the
 * same `--device` flag on their workers — ADR 0001 wants one definition of
 * that, not the two this repo has been bitten by before. This file is the
 * right home for the same reason it holds the manifests: dependency-free and
 * free of `Deno.*`, so the viewer can read a manifest's device without
 * dragging a Deno driver into its type graph.
 *
 * There is deliberately no 'rocm' member. A ROCm torch reports
 * `torch.cuda.is_available() == True` and takes the device string "cuda" —
 * that is how ROCm works, so an AMD box asks for 'cuda' like every other GPU
 * and `torch.version.hip` is what tells them apart, which only the worker can
 * see. 'mps' is here because Apple Silicon was otherwise unreachable: the
 * workers' resolution used to be a cuda-or-cpu binary, so a Mac silently ran
 * on CPU.
 *
 * This list mirrors `scripts/_torch_device.py`'s `CHOICES`, which is also what
 * `lingbot_map_worker.py` pins its argparse `choices` to. Keep them in step.
 */
export const COMPUTE_DEVICES = ['auto', 'cpu', 'cuda', 'mps'] as const
export type ComputeDevice = (typeof COMPUTE_DEVICES)[number]

/** Narrow an operator-supplied string (an env var, typically) to the union. */
export function isComputeDevice(value: string): value is ComputeDevice {
  return (COMPUTE_DEVICES as readonly string[]).includes(value)
}

/**
 * An indexed CUDA device — `cuda:1` on a multi-GPU host.
 *
 * Separate from `ComputeDevice` because only *one* worker takes it:
 * `panoptic_worker.py --device` is free-form and `resolve_torch_device` honours
 * an index verbatim, while `lingbot_map_worker.py` pins
 * `choices=[auto,cpu,cuda,mps]`, where `cuda:1` is an argparse exit-2. Folding
 * both into one loose predicate would let a driver accept a value its own
 * worker rejects.
 */
export type IndexedCudaDevice = `cuda:${number}`
export function isIndexedCudaDevice(value: string): value is IndexedCudaDevice {
  return /^cuda:\d+$/.test(value)
}

/**
 * panoptic_scan.ts's manifest — the per-keyframe panoptic segmenter.
 *
 * Panoptic means every pixel gets exactly one label, so a run yields BOTH
 * discrete objects ("things": chair, table, lamp) and room surfaces ("stuff":
 * wall, floor, ceiling). They are counted separately here because they are
 * handled separately downstream: things become WorldDetections and flow into
 * `thing_match`, stuff does not. See `panoptic_segments.ts` for why.
 */
export interface PanopticScanManifest extends PipelineManifestBase {
  tool: 'panoptic'
  sessionDir: string
  /** The HF model id the worker loaded, echoed back for provenance. */
  model?: string
  /** Keyframes the worker actually segmented. */
  framesSegmented?: number
  /** Discrete-object segments kept across all frames, before fusion. */
  thingCount?: number
  /** Room-surface segments seen. Recorded, but never fed to thing_match. */
  stuffCount?: number
  /**
   * Whether a thing-label list was supplied.
   *
   * Without one the worker reports every segment as unknown, which is treated
   * as stuff — so `thingCount: 0` means "things were disabled", not "this room
   * has no objects". Those are very different, and indistinguishable without
   * this flag: a path typo silently produced the former once already.
   */
  thingLabelsUsed?: boolean
  /** Basename of the landed per-frame segment JSON, relative to the session dir. */
  segmentsPath?: string
  /**
   * Backend the worker reported actually using — 'cuda', 'cpu', 'mps', …
   *
   * Not derivable from `params.device`. 'auto' is resolved inside the worker,
   * and even an explicit request is downgraded when the backend is absent
   * (scripts/_torch_device.py's `resolve_torch_device` downgrades an
   * unreachable backend to CPU rather than raising). The gap matters
   * because the same job is ~0.7 s/frame on the 4080 and minutes per frame on
   * CPU, and until now a run's manifest could not answer "did this use the
   * GPU?" — leaving a user staring at a slow job with nowhere to look.
   *
   * Absent when the worker did not say: it predates the reporting contract, or
   * it died before picking one.
   */
  resolvedDevice?: string
  /**
   * Which vendor's stack that backend was — 'NVIDIA CUDA', 'AMD ROCm',
   * 'Apple MPS', 'CPU'. `resolvedDevice` cannot carry this: a ROCm torch runs
   * on the device string "cuda", so 'cuda' alone does not say whose GPU it was.
   * Same field lingbot_map_worker.py already writes as `params.deviceVendor`.
   */
  deviceVendor?: string
  params: {
    python: string
    panopticDir: string
    model: string
    maxFrames: number
    minSegmentPixels: number
    /**
     * The backend that was *requested*, verbatim. Typed `string` rather than
     * `ComputeDevice` on purpose: an unrecognised `PANOPTIC_DEVICE` is recorded
     * here as it was written and the run is skipped with a remediation, which
     * is only useful if the typo survives into the manifest.
     */
    device: string
  }
}

/**
 * panoptic_lift.ts's manifest — the 2D-segment-to-3D-position stage.
 *
 * Splitting this from `panoptic-scan` rather than folding it into that job is a
 * cost decision: the segmenter is a GPU pass over up to 64 keyframes, and its
 * `panoptic.segments.json` is already on disk. Re-tuning the depth policy must
 * not mean re-running Mask2Former.
 *
 * The three counts are the point of this manifest, not decoration. "A room with
 * 6 things" and "a room where 44 objects were seen and could not be placed" are
 * completely different facts about a scan, and without the split they look
 * identical from outside — the same failure `thingLabelsUsed` above exists to
 * prevent. On the one real session measured (sess-a7e2f642, 50 thing segments,
 * 5330 points, coverageScore 0.0027) the split is 4 confident / 7
 * low-confidence / 39 with no answer at all.
 */
export interface PanopticLiftManifest extends PipelineManifestBase {
  tool: 'panoptic-lift'
  sessionDir: string
  /** Thing segments read from the panoptic-scan sidecar. */
  segmentCount?: number
  /**
   * Segments that produced a trusted world position — at or above the
   * confidence floor. `confidentCount + undeterminedCount === segmentCount`;
   * those two partition the set and are the only pair that does.
   */
  confidentCount?: number
  /**
   * Determinate but below the floor: a position was computed and is not
   * trusted, so it is NOT published as a Thing.
   *
   * A SUBSET of `undeterminedCount`, not a third bucket beside it — it is also
   * the `'low-confidence'` entry in `reasons`. Adding all three together
   * double-counts (a real run read 6 + 5 + 44 against 50 segments, which is
   * what prompted this note).
   */
  lowConfidenceCount?: number
  /**
   * Segments that yielded no publishable position, for any reason. Exactly
   * partitioned by `reasons`, whose values sum to this.
   */
  undeterminedCount?: number
  /** Count per LiftReason, e.g. { 'no-geometry': 2, unsupported: 33 }. */
  reasons?: Record<string, number>
  /** Median confidence across the confident set. Absent when that set is empty. */
  medianConfidence?: number
  /** Points in the cloud the rays were cast against. */
  pointCount?: number
  /** Basename of the written detections sidecar, relative to the scans dir. */
  detectionsPath?: string
  /** Which artifact supplied the cloud, for provenance. */
  cloudSource?: string
  params: {
    minSegmentPixels: number
    minConfidence: number
    minDepthM: number
    maxDepthM: number
    minClusterPoints: number
  }
}

/** splat_train.ts's manifest — the Brush CLI driver. */
export interface SplatTrainManifest extends PipelineManifestBase {
  tool: 'brush'
  sessionDir: string
  /** Basename of the landed .ply (relative to SCANS_DIR), when status is 'ok'. */
  plyPath?: string
  /** Basename of the compressed .ply, when Brush produced one. */
  compressedPlyPath?: string
  /** Number of gaussians in the exported PLY. */
  gaussianCount?: number
  /** Frames fed to the trainer. */
  frameCount?: number
  params: {
    brushBin: string
    device: string
    trainIters: number
    shDegree: number
    maxResolution: number
    evalEvery: number
  }
}

/**
 * colmap_poses.ts's manifest — the CPU structure-from-motion pose solver.
 *
 * Its outputs (`colmap.poses.json`, `colmap.point-cloud.ply`) intentionally
 * mirror LingBot-Map's, so `buildBrushDataset` reads either producer through
 * one code path (ADR 0001).
 */
export interface ColmapPosesManifest extends PipelineManifestBase {
  tool: 'colmap'
  sessionDir: string
  /** Basename of the written poses.json (relative to the session dir), when 'ok'. */
  posesPath?: string
  /** Basename of the sparse seed cloud, when points were triangulated. */
  pointCloudPath?: string
  /** Images COLMAP successfully registered. */
  registeredImages?: number
  /** Triangulated points in the sparse model. */
  pointCount?: number
  /** Keyframes offered to the solver. */
  frameCount?: number
  /**
   * The pre-rotation up direction estimated from the camera orientations, in
   * COLMAP's original world frame. Present only when the reconstruction was
   * gravity-aligned; absent means the cameras disagreed too much to tell.
   */
  upAxis?: [number, number, number]
  /** Whether the emitted poses/cloud were rotated so that up is +Y. */
  gravityAligned?: boolean
  params: {
    colmapBin: string
    featureType: string
    matcherType: string
    maxImageSize: number
  }
}

/**
 * The similarity transform that carries a splat out of structure-from-motion's arbitrary
 * frame and into a Place's metric project space.
 *
 * Why this type exists at all: monocular SfM reconstructs only *up to an unknown scale
 * factor* — COLMAP's output has no metres in it, sits at an arbitrary origin, and has an
 * arbitrary heading. A calibrated scan does have metres (ScanCalibration's two-point-ground
 * method carries a physically measured `separationM`). Those two facts were never connected,
 * which is why a trained splat could not be measured, placed beside its own mesh, or fused
 * with a second visit.
 *
 * The fit is Umeyama over a correspondence that already exists in the data: COLMAP's solved
 * camera centres and the calibrated session poses describe *the same physical camera path*,
 * once in arbitrary units and once in metres. Seven degrees of freedom (rotation 3,
 * translation 3, uniform scale 1) come out in closed form.
 *
 * Per ADR 0005's rule 3 — a status that claims verification must be backed by a measurement —
 * `residualM` is the RMS of the fitted correspondence in metres, and callers must treat a
 * large residual as "this fit is wrong", not as a number to display. `scale` is the single
 * most load-bearing field: it is what makes every downstream distance real.
 */
export interface SplatAlignManifest extends PipelineManifestBase {
  /**
   * Which of the two ways the metric frame was obtained.
   *
   * `'umeyama'` fits the solved camera path against a calibrated AR one and so
   * recovers all seven degrees of freedom. `'known-distance'` has no AR path to
   * fit against and recovers only what one measured length (plus, when the
   * solve found gravity, one up direction) can determine — read `determined`
   * before treating its `projectTransform` as a placement rather than a size.
   */
  tool: 'umeyama' | 'known-distance'
  /** Basename of the splat this transform applies to. */
  plyPath?: string
  /**
   * Row-major 4x4 mapping SfM space -> project space, scale already folded in. Column-major
   * would silently transpose against THREE.Matrix4.fromArray, so the convention is pinned
   * here and asserted in tests rather than left to the reader.
   */
  projectTransform?: number[]
  /** Uniform scale factor: multiply an SfM-space length by this to get metres. */
  scale?: number
  /** RMS fit residual in metres. Large = the correspondence disagreed; do not trust the fit. */
  residualM?: number
  /**
   * Which disagreement `residualM` measured. The two tiers have different
   * things to disagree about, and a reader comparing residuals across
   * manifests needs to know it is not comparing like with like.
   *
   * - `'camera-path'` — RMS over paired camera centres of (calibrated −
   *   fitted). The `'umeyama'` tier's residual, and the only one that measures
   *   all seven degrees of freedom at once.
   * - `'known-distance-cross-check'` — RMS over the supplied measured
   *   distances of (predicted − measured), with two or more spanning
   *   *different* pairs of viewpoints. Each such distance beyond the first is
   *   redundancy the scale did not get to absorb, so this measures the scale
   *   directly. The same pair measured twice is one constraint written twice,
   *   which the scale absorbs exactly, so it does not reach this source.
   * - `'viewpoint-scatter'` — RMS, in metres, of how far the frames claimed to
   *   share a viewpoint land from that viewpoint's centre. What is left when
   *   exactly one distance was measured, since the scale then fits it exactly
   *   and its own residual is arithmetic. It tests the grouping and the solve,
   *   not the tape reading.
   */
  residualSource?: 'camera-path' | 'known-distance-cross-check' | 'viewpoint-scatter'
  /** How many camera centres were paired to produce the fit. */
  correspondenceCount?: number
  /**
   * Which of the similarity's seven degrees of freedom this fit actually
   * pinned down. Absent on manifests written before the `'known-distance'` tier
   * existed, all of which were `'umeyama'` fits, i.e. all four true.
   *
   * The point of the field is that `projectTransform` is sixteen numbers
   * whether or not they mean anything: a `'known-distance'` frame still ships a
   * full 4x4, but its heading and origin are whatever the camera solve happened
   * to choose. Sizes and distances read off it are real; a bearing or a
   * position shared with another scan is not. A consumer that places one scan
   * beside another must check `heading` and `origin` here first — a scale-only
   * frame is exactly as arbitrary in those axes as no frame at all, so treating
   * it as a placement silently mis-registers the two.
   */
  determined?: {
    /** Lengths are in metres. False never ships — a fit without this is refused. */
    scale: boolean
    /** Which way is up is known, so the frame is not tilted by an unknown angle. */
    up: boolean
    /** Rotation about the up axis is known. False = the frame's bearing is arbitrary. */
    heading: boolean
    /** The origin is a known physical place, rather than wherever the solve put zero. */
    origin: boolean
  }
  /** Which calibration tier supplied the metric side — determines how much to trust `scale`. */
  calibrationMethod?: string
  /**
   * The physically measured distance a `'known-distance'` fit rests on, in
   * metres, and the length it corresponded to in solve units. Recorded so the
   * scale can be re-derived (and audited) from the two numbers that produced
   * it; absent on `'umeyama'` fits, which rest on a whole camera path instead.
   */
  knownDistance?: {
    measuredM: number
    solvedSeparation: number
    /** How many measured distances backed the frame. 1 = scale exact, no cross-check. */
    measurementCount: number
  }
  params: {
    minCorrespondences: number
    maxResidualM: number
  }
}

/** splat_detect.ts's manifest — the splat_analyzer (OWLv2 detection) driver. */
export interface SplatDetectManifest extends PipelineManifestBase {
  tool: 'splat-analyzer'
  /** Basename of the landed interactions.json (relative to SCANS_DIR), when 'ok'. */
  interactionsPath?: string
  /** Number of detected interactive objects. */
  objectCount?: number
  /** The open-vocab prompt fed to the detector. */
  prompt: string
  params: {
    python: string
    detectDir: string
    hipVisibleDevices: string
    pointSplatSize: string
    quality: string
    renderer: string
    scoreThreshold?: string
    minVotes?: string
    minPeakScore?: string
  }
}

export interface SplatFinishSizes {
  inputBytes: number
  sogBytes?: number | null
  compressedBytes?: number | null
}

/** splat_finish.ts's manifest — the @playcanvas/splat-transform driver. */
export interface SplatFinishManifest extends PipelineManifestBase {
  tool: 'splat-transform'
  /** Basename of the landed .sog (relative to SCANS_DIR), when status is 'ok'. */
  sogPath?: string
  /** Basename of the landed .compressed.ply, when status is 'ok'. */
  compressedPlyPath?: string
  /** Byte sizes of the input splat and both outputs (for UI ratios). */
  sizes?: SplatFinishSizes
  /** Number of gaussians in the input PLY. */
  gaussianCount?: number
  params: {
    nodeBin: string
    cliPath: string
    gpu: string
    iterations: number
  }
}

/**
 * `person_4d.ts`'s manifest — the 4D person capture driver.
 *
 * The **posed multi-view frame set** is the contract between capture and
 * processing, and this manifest is where its provenance is recorded. Both paths
 * produce that same artifact:
 *
 *  - one clip  → 4DAnyone synthesizes the views a camera array would have seen
 *  - N clips   → the real cameras already provide them, and 4DAnyone is skipped
 *
 * Recording which path ran is what makes the densifier swappable rather than a
 * dependency: nothing downstream of the frame set knows or cares which produced
 * it, and a future deformable trainer can replace the per-timestep step without
 * touching capture or playback.
 */
export interface Person4DManifest extends PipelineManifestBase {
  tool: '4d-capture'
  takeId: string
  /** How the views were obtained. 'densified' means 4DAnyone stood in for cameras. */
  viewSource?: 'densified' | 'multi-camera'
  /** Real clips in the take. 1 implies the densified path by construction. */
  clipCount: number
  /** Views per timestep fed to the trainer — real or synthesized. */
  viewCount?: number
  /** Timesteps trained; the sequence length. */
  frameCount?: number
  /** Playback rate of the sequence, distinct from the source clip's frame rate. */
  fps?: number
  durationMs?: number
  /** Directory under SCANS_DIR holding frame-NNNNN.sog, when status is 'ok'. */
  sequenceDir?: string
  /**
   * Worst inter-member residual at slice time, carried through from TakeSync.
   *
   * **Absent** when the take was unsynced — never defaulted to 0, which would
   * claim a measurement that was never made (ADR 0005 rule 3).
   */
  syncResidualMs?: number
  params: {
    host: string
    viewsPerLayer: number
    timestepFps: number
  }
}
