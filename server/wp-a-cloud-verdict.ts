/**
 * Whether a LingBot point cloud may be served, from the quality verdict in its manifest.
 *
 * The worker writes the cloud and reports `status: ok` whenever it finishes. The server then judges
 * the cloud and records the verdict in lingbot-map.manifest.json (server/lingbot-map/lingbot_map.ts,
 * recordLingBotVerdict). A cloud that verdict calls degenerate is refused: GET
 * /sessions/:id/lingbot-map.point-cloud.ply answers 409 with the reasons and the fix, instead of
 * handing a collapsed cloud to the viewer as a result.
 */

export interface DegenerateCloudRefusal {
  /** The problem, in one line. */
  error: string
  /** The judge's reason codes, for example `too-few-points`. */
  reasons: string[]
  /** The plain-language fix, when the manifest carries one. */
  remediation: string | null
}

const FALLBACK_ERROR = 'The point cloud is too sparse or collapsed to use.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The refusal for a cloud whose manifest verdict is degenerate, or `null` when the cloud may be
 * served. A manifest with no verdict, or with a verdict that is not degenerate, is served as before.
 */
export function degenerateCloudRefusal(manifest: unknown): DegenerateCloudRefusal | null {
  if (!isRecord(manifest) || !isRecord(manifest.quality)) return null
  if (manifest.quality.degenerate !== true) return null
  const reasons = Array.isArray(manifest.quality.reasons)
    ? manifest.quality.reasons.filter((reason): reason is string => typeof reason === 'string')
    : []
  return {
    error: typeof manifest.error === 'string' && manifest.error.length > 0 ? manifest.error : FALLBACK_ERROR,
    reasons,
    remediation: typeof manifest.remediation === 'string' ? manifest.remediation : null,
  }
}

/**
 * The LingBot manifest as GET /sessions/:id/lingbot-map.manifest.json serves it to the viewer. A run that
 * failed on a degenerate verdict keeps the problem in `error` and the fix in `remediation`
 * (server/lingbot-map/lingbot_map.ts, recordLingBotVerdict), and the viewer's panel shows only `error`. So
 * the fix is joined onto `error` in the served text. The file on disk is not changed, and any other
 * manifest is returned as it is.
 */
export function lingBotManifestForViewer(text: string): string {
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    return text
  }
  if (!isRecord(manifest) || manifest.status !== 'error') return text
  const fix = typeof manifest.remediation === 'string' ? manifest.remediation : ''
  if (fix === '') return text
  const problem = typeof manifest.error === 'string' ? manifest.error : ''
  if (problem.includes(fix)) return text
  const error = problem === '' ? fix : `${problem} ${fix}`
  return JSON.stringify({ ...manifest, error }, null, 2)
}
