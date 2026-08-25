/**
 * Trained-splat layer loader.
 *
 * When a scan has been through the `splat-train` world job, the server lands a
 * Gaussian-splat sidecar next to the source scan:
 *
 *   /scans/<base>.splat.ply                  INRIA 3DGS point cloud (Brush)
 *   /scans/<base>.splat-train.manifest.json  run index (status/gaussianCount)
 *
 * The follow-up `splat-finish` world job (auto-chained after train) adds the
 * web-delivery artifacts:
 *
 *   /scans/<base>.sog                         super-compressed SOG bundle
 *   /scans/<base>.compressed.ply              SuperSplat compressed PLY
 *   /scans/<base>.splat-finish.manifest.json  run index (status/sizes)
 *
 * The `splat-align` world job adds the transform that gives the splat a real
 * size and position:
 *
 *   /scans/<base>.splat-align.manifest.json   Umeyama fit (transform/scale/residual)
 *
 * This module discovers those manifests for a given scan, then reuses the PR#9
 * splat render path (src/viewer/splat-viewer.ts → loadSplat → SplatMesh) to
 * bring the splat into the scene — PREFERRING the finished artifacts (.sog,
 * then .compressed.ply, both natively supported by SparkJS) and gracefully
 * falling back to the raw .splat.ply. The resulting mesh is returned so the
 * caller can attach it under the selected scan's root (so the transform gizmo
 * moves the splat with the rest of the scan) and drive a visibility toggle.
 *
 * When the align fit is present and trustworthy, the mesh's local transform is
 * set from it, so the splat lands in the *same* space as the scan's GLB geometry
 * (which viewer.ts places directly under that same root) at true metric scale —
 * a splat and its mesh in one room, at one size, comparable by eye. When it is
 * absent or untrustworthy the mesh is left exactly as authored, in structure-
 * from-motion's arbitrary units, and `alignment` says so; per ADR 0005 rule 3
 * and wave 04 (`capture-path-truthfulness`), the UI must never imply a metric
 * placement it does not have.
 *
 * The manual URL/file panel from PR#9 is untouched — this is the automatic,
 * per-scan surface that mirrors the LingBot-Map overlay.
 */
import type {
  ScanManifest,
  SplatTrainManifest as ServerSplatTrainManifest,
  SplatFinishManifest as ServerSplatFinishManifest,
  SplatAlignManifest as ServerSplatAlignManifest,
} from '../world/types'
import { loadSplat, disposeSplat, applyRowMajorTransform, type LoadedSplat } from './splat-viewer'

/**
 * Viewer-side read of a splat-train manifest — the real server type
 * (SplatTrainManifest, defined in src/world/manifests.ts as an extension of
 * PipelineManifestBase and re-exported from src/world/types.ts), with
 * `timing.elapsedMs` loosened to optional: older on-disk manifests written
 * before that field existed still need to parse, and every read here already
 * goes through `m.timing?.elapsedMs` so nothing depends on it being present.
 */
export type SplatTrainManifest = Omit<ServerSplatTrainManifest, 'timing'> & {
  timing?: { elapsedMs?: number }
}

/**
 * Viewer-side read of a splat-finish manifest — the real server type
 * (SplatFinishManifest, see src/world/manifests.ts), with the same
 * `timing.elapsedMs` leniency as SplatTrainManifest above, plus
 * `sizes.inputBytes` loosened to optional/nullable for the same reason
 * (older manifests predating the sizes field, or a partially-written one).
 */
export type SplatFinishManifest = Omit<ServerSplatFinishManifest, 'timing' | 'sizes'> & {
  timing?: { elapsedMs?: number }
  sizes?: { inputBytes?: number | null; sogBytes?: number | null; compressedBytes?: number | null }
}

/**
 * Viewer-side read of a splat-align manifest — the real server type
 * (SplatAlignManifest, see src/world/manifests.ts), with the same
 * `timing.elapsedMs` leniency as the two above, plus `params` loosened to
 * optional: `minCorrespondences`/`maxResidualM` are the producer's own
 * thresholds, and a manifest written before they were recorded must still
 * parse. Every read here goes through `align.params?.x` and treats a missing
 * threshold as "no threshold to check against", never as zero.
 */
export type SplatAlignManifest = Omit<ServerSplatAlignManifest, 'timing' | 'params'> & {
  timing?: { elapsedMs?: number }
  params?: { minCorrespondences?: number; maxResidualM?: number }
}

/** Which served artifact actually backs the loaded SplatMesh. */
export type SplatLayerSource = 'sog' | 'compressed-ply' | 'ply'

/**
 * Whether the loaded splat is standing in metric project space, and — when it
 * isn't — the specific reason, so the UI can say which of the several quite
 * different "no" cases it is looking at.
 *
 * There are deliberately only two states. A third, "placed but unverified",
 * would be a status that claims a metric position with nothing measuring it,
 * which is what ADR 0005 rule 3 forbids: if the fit's accuracy was never
 * measured, or was measured and failed, the splat does not get moved.
 */
export type SplatAlignment =
  | {
    state: 'aligned'
    /** Multiply an SfM-space length by this to get metres. */
    scale: number
    /** RMS fit residual in metres — measured, never defaulted. */
    residualM: number
    /**
     * The ROW-MAJOR 4x4 that was applied. Carried on the verdict so callers
     * never reach back into the manifest and repeat the validation (and so
     * nothing needs a non-null assertion to get at it).
     */
    projectTransform: readonly number[]
    /** Camera centres paired to produce the fit, when the manifest recorded it. */
    correspondenceCount?: number
    /** Which calibration tier supplied the metric side of the fit. */
    calibrationMethod?: string
  }
  | {
    state: 'unaligned'
    /**
     * Why, as a sentence fragment that reads inside "Unaligned — arbitrary SfM
     * scale (<reason>)." Diagnostic on purpose: "the align job never ran" and
     * "the align job ran and the fit was 41 cm out" are opposite situations.
     */
    reason: string
  }

export interface ScanSplatLayer {
  scanId: string
  manifest: SplatTrainManifest
  /** The splat-finish manifest, when the finish job has run for this scan. */
  finish?: SplatFinishManifest
  /** The splat-align manifest, when the align job has run for this scan. */
  align?: SplatAlignManifest
  /**
   * The alignment verdict for the loaded mesh. Present whenever a splat
   * actually loaded — including, and especially, when the answer is 'unaligned'.
   */
  alignment?: SplatAlignment
  /** Present only when the manifest is 'ok' and a splat artifact loaded. */
  loaded?: LoadedSplat
  /** Served URL of the artifact that loaded (finish output or raw .ply). */
  plyUrl?: string
  /** Which artifact loaded: 'sog' | 'compressed-ply' | 'ply'. */
  loadedSource?: SplatLayerSource
  gaussianCount: number
}

/** Base name a scan's splat artifacts share, e.g. `home.glb` → `home`. */
export function scanArtifactBase(scan: ScanManifest): string {
  return scan.filename.replace(/\.glb$/, '')
}

/** URL of a scan's splat-train manifest on the gated artifact route. */
export function splatManifestUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.splat-train.manifest.json`)}`
}

/** URL of a scan's trained .ply on the gated artifact route. */
export function splatPlyUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.splat.ply`)}`
}

/** URL of a scan's splat-finish manifest on the gated artifact route. */
export function splatFinishManifestUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.splat-finish.manifest.json`)}`
}

/**
 * URL of a scan's splat-align manifest on the gated artifact route.
 *
 * Same `<base>.splat-<stage>.manifest.json` derivation as train and finish
 * above — the convention documented in src/world/manifests.ts, not a new
 * naming scheme (ADR 0001).
 */
export function splatAlignManifestUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.splat-align.manifest.json`)}`
}

/** URL of a scan's web-optimized SOG bundle on the gated artifact route. */
export function splatSogUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.sog`)}`
}

/** URL of a scan's compressed PLY on the gated artifact route. */
export function splatCompressedPlyUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.compressed.ply`)}`
}

/** Human-readable byte size for the toolbox stats line (1 decimal max). */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * One-line summary of a finish run for the toolbox stats, e.g.
 * "Compressed: 350.6 KB .sog · 740.7 KB .compressed.ply (13% of 2.8 MB)".
 * Returns '' when the finish job hasn't succeeded (yet).
 */
export function formatFinishStats(finish: SplatFinishManifest | undefined): string {
  if (!finish || finish.status !== 'ok') return ''
  const sizes = finish.sizes ?? {}
  const parts: string[] = []
  if (finish.sogPath) parts.push(`${formatBytes(sizes.sogBytes)} .sog`)
  if (finish.compressedPlyPath) parts.push(`${formatBytes(sizes.compressedBytes)} .compressed.ply`)
  if (parts.length === 0) return ''
  const input = sizes.inputBytes
  const smallest = [sizes.sogBytes, sizes.compressedBytes]
    .filter((n): n is number => typeof n === 'number' && n > 0)
    .sort((a, b) => a - b)[0]
  const ratio = typeof input === 'number' && input > 0 && typeof smallest === 'number'
    ? ` (${Math.max(1, Math.round((smallest / input) * 100))}% of ${formatBytes(input)})`
    : ''
  return `Compressed: ${parts.join(' · ')}${ratio}`
}

/**
 * Metres at the magnitude a human reads them: centimetres below a metre.
 * Used for both the fit residual and "how long is one SfM unit".
 */
export function formatMetres(metres: number | null | undefined): string {
  if (typeof metres !== 'number' || !Number.isFinite(metres)) return '?'
  return Math.abs(metres) < 1 ? `${(metres * 100).toFixed(1)} cm` : `${metres.toFixed(2)} m`
}

/**
 * Decide whether a splat-align manifest may move the splat, and say why not
 * when it may not.
 *
 * Every rejection below is deliberate rather than defensive boilerplate. The
 * transform is what turns a splat from "a shape at an unknown size" into "this
 * room, in metres", so a wrong one is worse than none at all: it renders
 * perfectly and quietly lies about where things are. Per ADR 0005 rule 3 a
 * claim of metric placement has to be backed by a measurement, so a fit with
 * **no** residual is rejected exactly like a fit with a **bad** residual — an
 * unmeasured fit is not a verified one, and there is no third status that
 * splits the difference.
 *
 * `params.maxResidualM` / `params.minCorrespondences` are splat-align's own
 * thresholds. Re-checking the producer's gates on the consumer side is cheap
 * and means a manifest written by an older or buggier producer cannot smuggle
 * a fit past them. A threshold that is absent is treated as "nothing to check
 * against" — never as 0, which would reject everything, and never as Infinity,
 * which would accept everything.
 */
export function resolveSplatAlignment(align: SplatAlignManifest | undefined): SplatAlignment {
  if (!align) {
    // Deliberately not "the align job has not run": a 404 here is equally
    // produced by a manifest the server does not serve (`.splat-align.manifest.json`
    // has to be in main.ts's SPLAT_ARTIFACT_MIME allowlist and its route regex,
    // exactly like the train/finish/detect sidecars). The viewer cannot tell the
    // two apart from a 404, so it does not claim to.
    return { state: 'unaligned', reason: 'no splat-align manifest available — the align job has not run, or is not served yet' }
  }
  if (align.status === 'skipped') {
    return { state: 'unaligned', reason: `splat-align skipped: ${align.skippedReason ?? 'no reason given'}` }
  }
  if (align.status !== 'ok') {
    return { state: 'unaligned', reason: `splat-align failed: ${align.error ?? 'unknown error'}` }
  }

  const transform = align.projectTransform
  if (
    !Array.isArray(transform) || transform.length !== 16 ||
    !transform.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    return { state: 'unaligned', reason: 'splat-align reported ok but carried no usable 4x4 projectTransform' }
  }

  const scale = align.scale
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    return { state: 'unaligned', reason: 'splat-align reported ok but carried no usable metric scale' }
  }

  const residualM = align.residualM
  if (typeof residualM !== 'number' || !Number.isFinite(residualM) || residualM < 0) {
    return {
      state: 'unaligned',
      reason: 'splat-align reported ok but never measured a fit residual, so the fit is unverified',
    }
  }

  const maxResidualM = align.params?.maxResidualM
  if (typeof maxResidualM === 'number' && Number.isFinite(maxResidualM) && maxResidualM > 0 && residualM > maxResidualM) {
    return {
      state: 'unaligned',
      reason: `fit residual ${formatMetres(residualM)} exceeds splat-align's own ${formatMetres(maxResidualM)} tolerance`,
    }
  }

  const correspondenceCount = align.correspondenceCount
  const minCorrespondences = align.params?.minCorrespondences
  if (
    typeof minCorrespondences === 'number' && typeof correspondenceCount === 'number' &&
    correspondenceCount < minCorrespondences
  ) {
    return {
      state: 'unaligned',
      reason: `the fit paired only ${correspondenceCount} camera(s), below splat-align's own minimum of ${minCorrespondences}`,
    }
  }

  return {
    state: 'aligned',
    scale,
    residualM,
    projectTransform: transform,
    correspondenceCount,
    calibrationMethod: align.calibrationMethod,
  }
}

/**
 * The sentence the user reads about where this splat is standing. Returns ''
 * only when no splat loaded at all — there is no silent case: a splat that is
 * on screen always states which frame it is in.
 *
 * Aligned:   "Aligned to project space at metric scale — 1 SfM unit = 8.1 cm, residual 3.1 cm over 24 cameras."
 * Unaligned: "Unaligned — arbitrary SfM scale (no splat-align manifest available — the align job has not run, or is not served yet)."
 *
 * The scale is stated as the metric length of one SfM unit rather than as a
 * "1:N" ratio on purpose: `scale` is defined as "multiply an SfM length by this
 * to get metres", and map-style ratio notation inverts differently depending on
 * which side the reader assumes is the model — an ambiguity that has no place
 * in the one sentence claiming the splat is measurable.
 */
export function formatAlignmentStatus(alignment: SplatAlignment | undefined): string {
  if (!alignment) return ''
  if (alignment.state === 'unaligned') return `Unaligned — arbitrary SfM scale (${alignment.reason}).`
  const cameras = typeof alignment.correspondenceCount === 'number'
    ? ` over ${alignment.correspondenceCount} cameras`
    : ''
  const via = alignment.calibrationMethod ? ` via ${alignment.calibrationMethod} calibration` : ''
  return `Aligned to project space at metric scale — 1 SfM unit = ${formatMetres(alignment.scale)}, ` +
    `residual ${formatMetres(alignment.residualM)}${cameras}${via}.`
}

/**
 * Fetch a scan's splat-train manifest and, when it succeeded, load the trained
 * splat into a SplatMesh. Returns null when the scan has no manifest yet (the
 * splat-train job hasn't run). The caller decides where to attach the mesh.
 *
 * When a splat-finish manifest exists with status ok, the finished artifacts
 * are preferred — `.sog` first (smallest), then `.compressed.ply` — each with
 * a graceful fallback so a bad/missing finish output never loses the splat.
 *
 * When a splat-align manifest exists and its fit is trustworthy, the mesh's
 * local transform is set from it so the splat stands in metric project space.
 * Otherwise the mesh is left as authored and `alignment` carries the reason —
 * see `resolveSplatAlignment` for what "trustworthy" means and why an
 * unmeasured fit counts as untrustworthy.
 *
 * `fetcher` is injectable so callers can add an access token / route it at a
 * test server, mirroring fetchLingBotMapArtifacts.
 */
export async function fetchScanSplatLayer(
  scan: ScanManifest,
  fetcher: (url: string) => Promise<Response> = fetch,
): Promise<ScanSplatLayer | null> {
  const manifestResp = await fetcher(splatManifestUrl(scan))
  if (!manifestResp.ok) return null
  const manifest = (await manifestResp.json()) as SplatTrainManifest

  if (manifest.status !== 'ok') {
    return {
      scanId: scan.scanId,
      manifest,
      gaussianCount: 0,
    }
  }

  // Discover the (optional) splat-finish outputs for this scan.
  let finish: SplatFinishManifest | undefined
  try {
    const finishResp = await fetcher(splatFinishManifestUrl(scan))
    if (finishResp.ok) finish = (await finishResp.json()) as SplatFinishManifest
  } catch {
    // finish manifest unavailable — raw .ply path still works
  }

  // Discover the (optional) splat-align fit. Fetched here rather than after the
  // load so that the artifact preference chain below stays exactly as it was —
  // alignment decides *where* the splat goes, never *which* file is fetched.
  let align: SplatAlignManifest | undefined
  try {
    const alignResp = await fetcher(splatAlignManifestUrl(scan))
    if (alignResp.ok) align = (await alignResp.json()) as SplatAlignManifest
  } catch {
    // align manifest unavailable — the splat still renders, just unaligned
  }

  // Preferred load order: web-optimized SOG → compressed PLY → raw PLY.
  const candidates: Array<{ url: string; source: SplatLayerSource }> = []
  if (finish?.status === 'ok' && finish.sogPath) {
    candidates.push({ url: splatSogUrl(scan), source: 'sog' })
  }
  if (finish?.status === 'ok' && finish.compressedPlyPath) {
    candidates.push({ url: splatCompressedPlyUrl(scan), source: 'compressed-ply' })
  }
  candidates.push({ url: splatPlyUrl(scan), source: 'ply' })

  let loaded: LoadedSplat | undefined
  let loadedFrom: { url: string; source: SplatLayerSource } | undefined
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      loaded = await loadSplat({ kind: 'url', url: withOrigin(fetcher, candidate.url) })
      loadedFrom = candidate
      break
    } catch (e) {
      lastError = e
      console.warn(`[splat-layer] ${candidate.source} load failed for ${candidate.url}, falling back:`, e)
    }
  }
  if (!loaded || !loadedFrom) throw lastError ?? new Error('no splat artifact loaded')

  // Place the splat in the Place's metric frame when — and only when — the fit
  // earns it. `applyRowMajorTransform` owns the row-major/column-major handling
  // (see its doc comment: a transposed similarity renders happily and is wrong),
  // and can still refuse a matrix that parsed but is singular, in which case the
  // honest answer flips back to 'unaligned' rather than leaving a verdict that
  // claims a placement the mesh did not receive.
  //
  // The fit is computed against the trained splat but applies to whichever
  // artifact loaded: splat-finish re-encodes the gaussians, it never re-frames
  // them, so .sog and .compressed.ply carry the raw .ply's coordinates.
  let alignment = resolveSplatAlignment(align)
  if (alignment.state === 'aligned' && !applyRowMajorTransform(loaded, alignment.projectTransform)) {
    alignment = {
      state: 'unaligned',
      reason: "splat-align's projectTransform is singular and cannot be decomposed into a placement",
    }
  }

  return {
    scanId: scan.scanId,
    manifest,
    finish,
    align,
    alignment,
    loaded,
    plyUrl: loadedFrom.url,
    loadedSource: loadedFrom.source,
    gaussianCount: manifest.gaussianCount ?? loaded.mesh.numSplats,
  }
}

/**
 * SparkJS resolves the SplatMesh URL itself (it can't take our custom
 * `fetcher`), so if the caller's fetcher rewrites the origin (e.g. a test
 * server on another port) we surface that origin here. In the normal viewer
 * the fetcher is the global `fetch` and the relative URL is used as-is.
 */
function withOrigin(fetcher: (url: string) => Promise<Response>, url: string): string {
  // The viewer passes a token-appending fetcher whose output stays same-origin,
  // so a relative URL is correct in production. Test harnesses that need a
  // cross-origin URL pass an absolute one via the manifest path already.
  void fetcher
  return url
}

export function disposeScanSplatLayer(layer: ScanSplatLayer): void {
  if (layer.loaded) disposeSplat(layer.loaded)
}
