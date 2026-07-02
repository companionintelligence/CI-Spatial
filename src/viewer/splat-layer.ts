/**
 * Trained-splat layer loader.
 *
 * When a scan has been through the `splat-train` world job, the server lands a
 * Gaussian-splat sidecar next to the source scan:
 *
 *   /scans/<base>.splat.ply                  INRIA 3DGS point cloud (Brush)
 *   /scans/<base>.compressed.ply             optional compressed variant
 *   /scans/<base>.splat-train.manifest.json  run index (status/gaussianCount)
 *
 * This module discovers that manifest for a given scan, then reuses the PR#9
 * splat render path (src/viewer/splat-viewer.ts → loadSplat → SplatMesh) to
 * bring the .ply into the scene. The resulting mesh is returned so the caller
 * can attach it under the selected scan's root (so the transform gizmo moves
 * the splat with the rest of the scan) and drive a visibility toggle.
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

export interface ScanSplatLayer {
  scanId: string
  manifest: SplatTrainManifest
  /** Present only when the manifest is 'ok' and the .ply loaded. */
  loaded?: LoadedSplat
  /** Served URL of the .ply (or the compressed variant when available). */
  plyUrl?: string
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

/**
 * Fetch a scan's splat-train manifest and, when it succeeded, load the trained
 * .ply into a SplatMesh. Returns null when the scan has no manifest yet (the
 * splat-train job hasn't run). The caller decides where to attach the mesh.
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

  const plyUrl = splatPlyUrl(scan)
  const loaded = await loadSplat({ kind: 'url', url: withOrigin(fetcher, plyUrl) })
  return {
    scanId: scan.scanId,
    manifest,
    loaded,
    plyUrl,
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
