/**
 * Per-scan "map quality" tier — one coherent headline state derived from the
 * three artifact manifests the editor already fetches per scan:
 *
 *   Preview       point cloud / GLB only (every loaded scan has this)
 *   Reconstructed LingBot-Map point-cloud manifest is `ok`
 *                 (fetchLingBotMapArtifacts → lingbot-map.manifest.json)
 *   Photoreal     trained-splat manifest is `ok`
 *                 (fetchScanSplatLayer → <base>.splat-train.manifest.json)
 *
 * This module is intentionally pure: it takes the *presence/status* of those
 * artifacts (booleans the caller reads off the already-cached overlay/layer
 * objects) and returns the tier plus the next-step copy. The viewer owns the
 * fetching and DOM; keeping the mapping here makes it unit-testable and keeps
 * the internal engine names (LingBot-Map, Brush) out of the headline.
 */
import type { WorldJobType } from '../world/types'

export type QualityTier = 'preview' | 'reconstructed' | 'photoreal'

/** Ordered tiers, lowest → highest, for stepper rendering. */
export const QUALITY_TIERS: readonly QualityTier[] = ['preview', 'reconstructed', 'photoreal'] as const

/** Human labels for each tier (no internal engine names). */
export const QUALITY_TIER_LABELS: Record<QualityTier, string> = {
  preview: 'Preview',
  reconstructed: 'Reconstructed',
  photoreal: 'Photoreal',
}

/** One-line description of what each tier means, for the badge subtitle. */
export const QUALITY_TIER_BLURBS: Record<QualityTier, string> = {
  preview: 'Point cloud / mesh only.',
  reconstructed: 'Dense point cloud reconstructed from keyframes.',
  photoreal: 'Trained Gaussian splat — photoreal detail.',
}

export interface QualityArtifacts {
  /** LingBot-Map reconstruction manifest exists and status is `ok`. */
  reconstructedOk: boolean
  /** Trained-splat manifest exists and status is `ok`. */
  splatOk: boolean
}

export interface QualityTierState {
  tier: QualityTier
  /** Copy nudging the user to the next tier, or null when already Photoreal. */
  nextStep: string | null
}

/**
 * Derive the tier from which artifacts exist. Photoreal wins even if the
 * reconstruction step was skipped (a trained splat is strictly richer), so the
 * splat check comes first.
 */
export function computeQualityTier(artifacts: QualityArtifacts): QualityTierState {
  if (artifacts.splatOk) {
    return { tier: 'photoreal', nextStep: null }
  }
  if (artifacts.reconstructedOk) {
    return {
      tier: 'reconstructed',
      nextStep: 'Train a splat to reach Photoreal.',
    }
  }
  return {
    tier: 'preview',
    nextStep: 'Reconstruct from your keyframes to reach Reconstructed.',
  }
}

/**
 * Friendly present-continuous label for a world job the selected scan is
 * currently queued/processing, e.g. `splat-train` → "training splat". Returns
 * null for job types with no user-facing quality meaning, so the caller hides
 * the processing line for those.
 */
export function jobProcessingLabel(type: WorldJobType): string | null {
  switch (type) {
    case 'lingbot-map-reconstruct':
    case 'depth-reconstruct':
    case 'merge-points':
      return 'reconstructing'
    case 'splat-train':
      return 'training splat'
    case 'splat-detect':
      return 'detecting objects'
    case 'semantic-pass':
      return 'labeling objects'
    case 'align-scan':
      return 'aligning'
    case 'ingest':
    case 'extract-layers':
      return 'processing'
    default:
      return null
  }
}
