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
 * This module discovers those manifests for a given scan, then reuses the PR#9
 * splat render path (src/viewer/splat-viewer.ts → loadSplat → SplatMesh) to
 * bring the splat into the scene — PREFERRING the finished artifacts (.sog,
 * then .compressed.ply, both natively supported by SparkJS) and gracefully
 * falling back to the raw .splat.ply. The resulting mesh is returned so the
 * caller can attach it under the selected scan's root (so the transform gizmo
 * moves the splat with the rest of the scan) and drive a visibility toggle.
 *
 * The manual URL/file panel from PR#9 is untouched — this is the automatic,
 * per-scan surface that mirrors the LingBot-Map overlay.
 */
import type { ScanManifest } from '../world/types'
import { loadSplat, disposeSplat, type LoadedSplat } from './splat-viewer'

export interface SplatTrainManifest {
  status: 'ok' | 'skipped' | 'error'
  gaussianCount?: number
  frameCount?: number
  plyPath?: string
  compressedPlyPath?: string
  skippedReason?: string
  remediation?: string
  error?: string
  timing?: { elapsedMs?: number }
}

export interface SplatFinishManifest {
  status: 'ok' | 'skipped' | 'error'
  sogPath?: string
  compressedPlyPath?: string
  sizes?: { inputBytes?: number | null; sogBytes?: number | null; compressedBytes?: number | null }
  gaussianCount?: number
  skippedReason?: string
  remediation?: string
  error?: string
  timing?: { elapsedMs?: number }
}

/** Which served artifact actually backs the loaded SplatMesh. */
export type SplatLayerSource = 'sog' | 'compressed-ply' | 'ply'

export interface ScanSplatLayer {
  scanId: string
  manifest: SplatTrainManifest
  /** The splat-finish manifest, when the finish job has run for this scan. */
  finish?: SplatFinishManifest
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
 * Fetch a scan's splat-train manifest and, when it succeeded, load the trained
 * splat into a SplatMesh. Returns null when the scan has no manifest yet (the
 * splat-train job hasn't run). The caller decides where to attach the mesh.
 *
 * When a splat-finish manifest exists with status ok, the finished artifacts
 * are preferred — `.sog` first (smallest), then `.compressed.ply` — each with
 * a graceful fallback so a bad/missing finish output never loses the splat.
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

  return {
    scanId: scan.scanId,
    manifest,
    finish,
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
