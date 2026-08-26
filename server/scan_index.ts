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

/**
 * Non-empty line count in `keyframes.jsonl`, treated as 0 when the file does
 * not exist yet. Matches `POST /sessions/:id/finalize`'s own counting logic
 * exactly (`main.ts`), so a session reports the same number whether read live
 * here or after finalize writes it to `session.json`.
 */
async function liveKeyframeCount(sessionsDir: string, sessionId: string): Promise<number> {
  try {
    const jsonl = await Deno.readTextFile(`${sessionsDir}/${sessionId}/keyframes.jsonl`)
    return jsonl.split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

export interface SessionIndex {
  /** session directory name → parsed session.json, in `Deno.readDir` order. */
  bySessionId: Map<string, Record<string, unknown>>
  /** session record's `glbFilename` → that record. First writer in readDir order wins. */
  byGlb: Map<string, Record<string, unknown>>
  /**
   * `takeId` → the session ids sharing it, in `Deno.readDir` order.
   *
   * A take is N simultaneous captures of one subject, and it is deliberately a
   * *derived* set rather than a stored aggregate — so this grouping is folded
   * into the single sweep above rather than given its own directory scan. That
   * matters: the whole reason this module exists is that a per-scan directory
   * walk was O(scans × sessions) and took 120s on ~2,900 files. Adding a
   * per-take walk would reintroduce exactly that.
   */
  byTakeId: Map<string, string[]>
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
  const byTakeId = new Map<string, string[]>()
  // Sessions whose session.json has never had finalize's real count written
  // to it — see the live-count backfill below.
  const needsLiveCount: string[] = []

  try {
    for await (const entry of Deno.readDir(sessionsDir)) {
      if (!entry.isDirectory) continue
      try {
        const record = JSON.parse(
          await Deno.readTextFile(`${sessionsDir}/${entry.name}/session.json`),
        ) as Record<string, unknown>
        bySessionId.set(entry.name, record)
        // Gated on the field already being present, not just on finalizedAt
        // being absent — a record with no keyframeCount at all was never
        // shaped like a capture session (a synthetic fixture, or a future
        // session kind that doesn't track this), and must not gain one from
        // nowhere.
        if ('keyframeCount' in record && !asString(record['finalizedAt'])) {
          needsLiveCount.push(entry.name)
        }
        const glb = asString(record['glbFilename'])
        // First match in readDir order wins, matching the old sweep's early return.
        if (glb && !byGlb.has(glb)) byGlb.set(glb, record)
        // Unlike glbFilename, a takeId groups rather than resolves — every
        // member session belongs, so this accumulates instead of first-wins.
        const takeId = asString(record['takeId'])
        if (takeId) {
          const members = byTakeId.get(takeId)
          if (members) members.push(entry.name)
          else byTakeId.set(takeId, [entry.name])
        }
      } catch { /* incomplete session dir */ }
    }
  } catch { /* sessions dir missing */ }

  // `session.json`'s `keyframeCount` is written twice: 0 at creation
  // (POST /sessions), and the real count only by POST /sessions/:id/finalize.
  // A session that is still streaming, or was abandoned without ever calling
  // finalize — tab closed, app backgrounded, phone locked mid-scan, all
  // observed in practice — sits at its creation-time 0 forever, indistinguishable
  // from a session that genuinely captured nothing. Backfill it here from the
  // keyframe log itself, for exactly the subset that was never finalized.
  //
  // Bounded by how many sessions are currently open, not by history, so this
  // does not reintroduce the O(scans × sessions) sweep this module exists to
  // avoid (see the module doc) — a finalized session is trusted as-is and
  // costs nothing extra, which is the common case for anything old enough to
  // matter for that cost. Counted concurrently rather than one directory read
  // at a time in the loop above, so a handful of open sessions cost one round
  // trip's worth of latency, not N sequential ones.
  if (needsLiveCount.length > 0) {
    const counts = await Promise.all(
      needsLiveCount.map((id) => liveKeyframeCount(sessionsDir, id)),
    )
    needsLiveCount.forEach((id, i) => {
      const record = bySessionId.get(id)
      if (record) record['keyframeCount'] = counts[i]
    })
  }

  return { bySessionId, byGlb, byTakeId }
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

/**
 * The session records belonging to one take, in sweep order.
 *
 * Empty for an unknown take id, and for a solo capture — a session with no
 * `takeId` is not a one-member take, it is simply not part of one, and the two
 * must stay distinguishable.
 */
export function sessionsForTake(index: SessionIndex, takeId: string): Record<string, unknown>[] {
  const ids = index.byTakeId.get(takeId)
  if (!ids) return []
  const out: Record<string, unknown>[] = []
  for (const id of ids) {
    const record = index.bySessionId.get(id)
    if (record) out.push(record)
  }
  return out
}
