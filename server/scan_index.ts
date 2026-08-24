/**
 * Session index for the scan listing: sweeps `scans/sessions/` **once** per
 * `GET /scans`, instead of once per scan.
 *
 * Why this exists: `listStoredScans()` loops every non-derived `.glb` and awaits
 * `readScanMeta()`, which called `readSessionRecordForScan()`, which ran its own
 * `Deno.readDir(SESSIONS_DIR)` and read `session.json` for every session directory —
 * for every scan. That is O(scans × sessions), not merely "serial stats": a library of
 * ~2,900 files took 120 seconds against 18ms on an empty directory, and that timeout is
 * what made the editor's geomap fail during the readiness review, because the viewer
 * never populated.
 *
 * Deliberately NOT a cache. Directory mtime does not change on in-place file rewrites,
 * and `POST /sessions/:id/finalize` rewrites `session.json` in place, so an mtime-keyed
 * cache would serve stale `qualitySummary` and `status` indefinitely after any finalize.
 * Building the index once per call is already linear; a cache would only add an
 * invalidation contract spanning upload, both deletes, finalize, and every job runner.
 *
 * It lives in its own module rather than in `main.ts` for the same reason `world_lock.ts`
 * and `world_job_pump.ts` do: so it is importable, and unit-testable, without `main.ts`'s
 * unconditional top-level `Deno.serve`. For the same reason it inlines its two predicates
 * rather than importing them from `main.ts`.
 */

/** Mirrors `main.ts`'s `asString` — inlined so this module imports nothing from it. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export interface SessionIndex {
  /** session directory name → parsed session.json, in `Deno.readDir` order. */
  bySessionId: Map<string, Record<string, unknown>>
  /** session record's `glbFilename` → that record. First writer in readDir order wins. */
  byGlb: Map<string, Record<string, unknown>>
}

/**
 * Sweep the sessions directory once, parsing each `session.json`.
 *
 * Matches the behaviour the two previous sweeps shared: skip non-directories, swallow an
 * unreadable or unparseable `session.json` as "incomplete session dir", and swallow a
 * missing sessions directory entirely.
 */
export async function loadSessionIndex(sessionsDir: string): Promise<SessionIndex> {
  const bySessionId = new Map<string, Record<string, unknown>>()
  const byGlb = new Map<string, Record<string, unknown>>()

  try {
    for await (const entry of Deno.readDir(sessionsDir)) {
      if (!entry.isDirectory) continue
      try {
        const record = JSON.parse(
          await Deno.readTextFile(`${sessionsDir}/${entry.name}/session.json`),
        ) as Record<string, unknown>
        bySessionId.set(entry.name, record)
        const glb = asString(record['glbFilename'])
        // First match in readDir order wins, matching the old sweep's early return.
        if (glb && !byGlb.has(glb)) byGlb.set(glb, record)
      } catch { /* incomplete session dir */ }
    }
  } catch { /* sessions dir missing */ }

  return { bySessionId, byGlb }
}

/**
 * Resolve the session record for one scan, preserving `readSessionRecordForScan`'s
 * resolution order exactly:
 *
 *  - An explicit `meta.sessionId` matches **only** that session directory. The old sweep
 *    skipped every other entry (`if (explicit && entry.name !== explicit) continue`), so a
 *    scan naming a session must never fall back to a `glbFilename` match — it resolves to
 *    that session or to null.
 *  - When the index misses an explicit `sessionId`, one direct read is still attempted.
 *    That is the old code's post-sweep fallback loop, and it is what covers a session whose
 *    entry is not a directory, or a sessions directory that could not be listed. It is
 *    O(1) per scan, so it does not reintroduce the blowup.
 *  - With no explicit `sessionId`, the first record whose `glbFilename` matches wins.
 */
export async function sessionForScan(
  index: SessionIndex,
  sessionsDir: string,
  filename: string,
  meta: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const explicit = asString(meta['sessionId'])

  if (explicit) {
    const indexed = index.bySessionId.get(explicit)
    if (indexed) return indexed
    try {
      return JSON.parse(
        await Deno.readTextFile(`${sessionsDir}/${explicit}/session.json`),
      ) as Record<string, unknown>
    } catch {
      return null
    }
  }

  return index.byGlb.get(filename) ?? null
}
