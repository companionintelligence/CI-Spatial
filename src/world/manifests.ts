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
