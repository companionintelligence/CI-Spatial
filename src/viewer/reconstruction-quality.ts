/**
 * Reconstruction-quality verdict for the Map Quality headline.
 *
 * The COLMAP pose solver writes `<session>/colmap-poses.manifest.json`, and as
 * of 2026-08-30 that manifest carries a `quality` verdict alongside the raw
 * counts (`server/colmap/colmap_poses.ts` → `ColmapReconstructionQuality`).
 * The verdict exists because a run that finishes is not a run that worked: on
 * the same night, the video fixture registered 32 of 32 keyframes with 9362
 * triangulated points, and a 17-keyframe phone capture registered 3 with 1
 * point. Both reported `status: 'ok'`, and in this editor both looked
 * identical — a "Reconstructed" tier and nothing else. The counts were on disk
 * the whole time; nothing read them.
 *
 * This module is the read side of that. It is deliberately pure apart from one
 * fetch, mirroring `lingbot-map.ts`'s treatment of the other session-level
 * manifest, so the copy can be unit-tested without a scene or a server.
 *
 * ## Why the types are re-declared rather than imported
 *
 * `ColmapReconstructionQuality` lives in `server/colmap/colmap_poses.ts`, a
 * Deno module that reads `Deno.env` at import time and uses `.ts` specifiers —
 * it cannot enter the Vite bundle. `src/viewer/lingbot-map.ts` hit exactly this
 * and resolved it the same way: declare the fields actually read, and say where
 * the writer is. `ScanReviewStatus` itself IS shared (src/world/types.ts), so
 * the one field that matters most is imported, not copied — that is the point
 * of ADR 0001, and it is why the server chose `ScanReviewStatus` for `status`
 * instead of a private good/bad enum. When `ColmapReconstructionQuality` moves
 * to `src/world/manifests.ts` (its own doc comment says that is where it
 * belongs), the block below collapses to an import.
 *
 * ## Why every threshold decision stays on the server
 *
 * Nothing here re-derives `degenerate` from the counts. A manifest written
 * before the verdict existed — the video fixture's is one — simply has no
 * `quality` field, and this reports the counts as facts with no verdict
 * attached rather than applying thresholds the run was never judged against.
 * Guessing a verdict the producer did not make is the failure ADR 0005 rule 3
 * names: a claim with no measurement behind it.
 */
import type { ScanReviewStatus } from '../world/types'

/** Why a solve was judged degenerate. Mirrors `ColmapQualityReason`. */
export type ReconstructionQualityReason = 'low-registration-ratio' | 'too-few-points'

/** The `quality` block of colmap-poses.manifest.json. */
export interface ReconstructionQuality {
  registrationRatio: number
  degenerate: boolean
  status: ScanReviewStatus
  reasons: ReconstructionQualityReason[]
  thresholds?: { minRegistrationRatio?: number; minPoints3D?: number }
}

/**
 * The fields of colmap-poses.manifest.json this panel reads.
 *
 * Every one is optional because a manifest is written at several exit points
 * (skipped before COLMAP ran, error mid-solve, ok with a full model) and an
 * older one predates `quality` entirely. A reader that assumes any of them is
 * present renders "undefined" at the user in the one place they are deciding
 * whether to trust a scan.
 */
export interface ColmapPosesManifestRead {
  status?: 'ok' | 'skipped' | 'error'
  skippedReason?: string
  error?: string
  /**
   * The producer's own plain-language fix, written by
   * `degenerateRemediation()`. Preferred over anything composed here whenever
   * present: it is written by the code that measured the failure, and it is
   * already aimed at the person holding the phone.
   */
  remediation?: string
  frameCount?: number
  registeredImages?: number
  pointCount?: number
  quality?: ReconstructionQuality
}

/** How the verdict should read — drives both wording and colour. */
export type ReconstructionTone = 'ready' | 'needs-review' | 'needs-rescan' | 'unrated' | 'blocked'

export interface ReconstructionVerdict {
  tone: ReconstructionTone
  /** One short sentence, the thing a non-expert reads first. */
  headline: string
  /** What was measured and, when it went wrong, what to do about it. */
  detail: string
}

/** URL of a session's COLMAP manifest, same `/sessions/:id/<artifact>` shape the LingBot-Map overlay uses. */
export function colmapPosesManifestUrl(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/colmap-poses.manifest.json`
}

/**
 * Read a session's COLMAP manifest. Returns null when there is none — which is
 * the ordinary case for a scan whose poses came from the device or from
 * LingBot-Map, not a failure, so the caller hides the line rather than
 * reporting an absence.
 */
export async function fetchReconstructionQuality(
  sessionId: string,
  fetcher: (url: string) => Promise<Response> = fetch,
): Promise<ColmapPosesManifestRead | null> {
  try {
    const resp = await fetcher(colmapPosesManifestUrl(sessionId))
    if (!resp.ok) return null
    return (await resp.json()) as ColmapPosesManifestRead
  } catch {
    return null
  }
}

/** "32 of 32" / "3 of 17", or '' when the manifest never recorded both counts. */
function photosPlaced(m: ColmapPosesManifestRead): string {
  const placed = m.registeredImages
  const total = m.frameCount
  if (typeof placed !== 'number' || typeof total !== 'number' || total <= 0) return ''
  return `${placed.toLocaleString()} of ${total.toLocaleString()}`
}

/**
 * The advice a degenerate solve earns, in the words of someone standing in the
 * room that produced it.
 *
 * Only used when the manifest carries no `remediation` of its own. The three
 * fixes are ordered by how much they moved the needle on the capture that
 * prompted this — light first (the failing room measured 50–330 SIFT features
 * per frame against thousands in a well-lit one), then texture, then parallax.
 */
function fallbackRemediation(reasons: readonly ReconstructionQualityReason[]): string {
  const causes = reasons.includes('too-few-points') && reasons.includes('low-registration-ratio')
    ? 'The camera could not recognise the same spot in two different photos.'
    : reasons.includes('too-few-points')
      ? 'The photos barely overlap in anything the camera can recognise.'
      : 'Most photos could not be placed relative to each other.'
  return (
    `${causes} That almost always means the room was too dark or too plain. ` +
    'Turn on every light and open the blinds; point the camera at things with visible ' +
    'pattern — bookshelves, pictures, furniture, a patterned rug — rather than bare walls ' +
    'or shiny surfaces; and walk sideways across the room while you scan instead of ' +
    'turning on the spot. Move slowly enough that nothing blurs.'
  )
}

/**
 * Turn a manifest into the two sentences shown under the Map Quality stepper,
 * or null when it has nothing to say.
 *
 * Written for a non-expert throughout: "17 of 17 photos placed", never
 * "registration ratio 0.18". The ratio is the measurement, not the message —
 * a number between 0 and 1 tells the person who has to re-scan the room
 * nothing they can act on, and it is the reason a good and a useless scan read
 * the same in this panel until now.
 */
export function formatReconstructionVerdict(
  m: ColmapPosesManifestRead | null,
): ReconstructionVerdict | null {
  if (!m) return null

  if (m.status === 'skipped') {
    return {
      tone: 'blocked',
      headline: 'Camera positions were never worked out for this scan.',
      detail: m.remediation ?? m.skippedReason ?? 'The pose solver did not run.',
    }
  }
  if (m.status === 'error') {
    return {
      tone: 'blocked',
      headline: 'Working out the camera positions failed.',
      detail: m.remediation ?? m.error ?? 'No reason was recorded.',
    }
  }
  if (m.status !== 'ok') return null

  const placed = photosPlaced(m)
  const points = typeof m.pointCount === 'number' ? m.pointCount : null
  // Stated as "shared detail", not "triangulated 3D points": what the number
  // means to the person reading it is how much of the room two photos agreed
  // on, and that is what makes 1 obviously bad next to 9,362.
  const detailPoints = points === null
    ? ''
    : ` The photos shared ${points.toLocaleString()} recognisable point${points === 1 ? '' : 's'} of detail.`

  const q = m.quality
  if (!q) {
    // Pre-verdict manifest. Report the counts, claim nothing about them.
    if (!placed && points === null) return null
    return {
      tone: 'unrated',
      headline: placed ? `${placed} photos were placed in 3D.` : 'Camera positions were worked out.',
      detail: `This scan finished before quality was measured, so there is no verdict on it — only the counts.${detailPoints}`,
    }
  }

  if (q.status === 'needs-rescan' || q.degenerate) {
    return {
      tone: 'needs-rescan',
      headline: placed
        ? `Only ${placed} photos could be placed in 3D — this scan needs re-capturing.`
        : 'This scan came out too thin to use — it needs re-capturing.',
      detail: m.remediation ?? fallbackRemediation(q.reasons ?? []),
    }
  }

  if (q.status === 'needs-review') {
    return {
      tone: 'needs-review',
      headline: placed
        ? `${placed} photos were placed in 3D — worth a look before you trust it.`
        : 'This scan is usable, but worth a look before you trust it.',
      detail:
        `Check the shape of the room against what you remember before measuring anything in it.${detailPoints}`,
    }
  }

  // "All 32 photos", not "All 32 of 32 photos" — the ratio is the interesting
  // half only when it is short of the whole.
  const allPlaced = m.registeredImages === m.frameCount
  return {
    tone: 'ready',
    headline: !placed
      ? 'Every photo was placed in 3D.'
      : allPlaced
        ? `All ${(m.frameCount ?? 0).toLocaleString()} photos were placed in 3D.`
        : `${placed} photos were placed in 3D.`,
    detail: `The camera tracked cleanly through this capture.${detailPoints}`,
  }
}
