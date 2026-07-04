/**
 * Splat Toolbox — job-request helpers for the consolidated desktop-editor panel.
 *
 * The Layers-tab "Splat Toolbox" section drives two world jobs for the selected
 * scan: `splat-train` (Brush 3DGS training) and `splat-detect` (splat-analyzer
 * open-vocab object detection). Both POST to /worlds/:slug/jobs with the exact
 * contract the server agent defined:
 *
 *   splat-train  → { type:'splat-train', scanId }
 *   splat-detect → { type:'splat-detect', scanId, payload:{ prompt? } }
 *
 * These builders are pure so the mock-splat-toolbox spec can assert the request
 * body without a live coordinator; viewer.ts owns the actual fetch (it holds the
 * access token + world slug).
 */
import type { WorldJobType } from '../world/types'

export interface SplatJobRequest {
  type: WorldJobType
  scanId: string
  payload?: Record<string, unknown>
}

/** Body for the Train-splat button: a splat-train job for the selected scan. */
export function buildTrainJobRequest(scanId: string): SplatJobRequest {
  return {
    type: 'splat-train',
    scanId,
    payload: { source: 'viewer-toolbox', requestedAt: new Date().toISOString() },
  }
}

/**
 * Body for the Detect-objects button: a splat-detect job for the selected scan.
 * A non-empty prompt is forwarded as `payload.prompt`; an empty/blank prompt is
 * omitted so the server driver falls back to its SPLAT_DETECT_PROMPT default.
 */
export function buildDetectJobRequest(scanId: string, prompt?: string): SplatJobRequest {
  const trimmed = (prompt ?? '').trim()
  const payload: Record<string, unknown> = { source: 'viewer-toolbox', requestedAt: new Date().toISOString() }
  if (trimmed) payload['prompt'] = trimmed
  return { type: 'splat-detect', scanId, payload }
}
