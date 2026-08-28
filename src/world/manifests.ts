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
  params: {
    python: string
    panopticDir: string
    model: string
    maxFrames: number
    minSegmentPixels: number
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
  tool: 'umeyama'
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
  /** How many camera centres were paired to produce the fit. */
  correspondenceCount?: number
  /** Which calibration tier supplied the metric side — determines how much to trust `scale`. */
  calibrationMethod?: string
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
