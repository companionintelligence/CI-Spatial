/**
 * Per-world-slug write lock: serializes `read world file → mutate → write
 * world file` cycles so two concurrent cycles can't lose an update.
 *
 * Why this exists: `main.ts`'s `saveWorld()` writes atomically (tmp file +
 * rename), so a reader never sees a torn file — but atomicity is not
 * isolation. Nothing stopped two `loadWorld() → mutate → saveWorld()` cycles
 * from interleaving, and when they did, the second writer's snapshot (taken
 * before the first writer's save) silently overwrote the first writer's
 * change. The observed symptom was optimize-scan jobs reverting to
 * `status: 'processing'`, `progress: 0.35` — the exact values
 * `_dispatchWorldJob` writes when it marks a job processing — after they had
 * already completed, leaving them stuck until the next boot-time recovery
 * requeued them.
 *
 * The 01-merge-jobs wave made that far more likely: `optimize-scan` used to
 * persist to its own `scans/jobs.json` behind a single writer (the retired
 * `JobQueue`), and now shares `worlds/<slug>.json` with every `/upload-scan`,
 * every job transition, and every editor action.
 *
 * The primitive is a promise chain per slug — the same "chain the next
 * operation onto the previous one's tail" shape `src/viewer/viewer.ts`'s
 * `enqueueScanLoad()` already uses per scanId, and a sibling of
 * `world_job_pump.ts`'s single-flight pump (that one serializes job
 * *execution*; this one serializes world-file *persistence*). It lives in its
 * own module rather than in `main.ts` for the same reason the pump does: so
 * it's importable, and unit-testable, without `main.ts`'s unconditional
 * top-level side effects.
 *
 * NOT reentrant: a critical section must never call `withWorldLock` again for
 * the same slug — it would wait on itself forever. In `main.ts` that means
 * only `loadWorld`/`updateWorld`/`mutateWorldFiles` take the lock; the
 * unlocked `readWorldUnlocked`/`writeWorldUnlocked` primitives they call
 * inside it never do.
 *
 * In-process only. It assumes the single-process-server model ADR 0003
 * already assumes for crash recovery; two server processes sharing a
 * `WORLDS_DIR` would still race.
 */

/** slug → tail of the currently queued critical sections (settled-swallowing). */
const _chains = new Map<string, Promise<void>>()

/**
 * Run `critical` with exclusive access to `slug`, after every critical
 * section already queued for that slug has settled. Different slugs never
 * block each other. The caller sees `critical`'s own resolution or rejection
 * unchanged — a section that throws releases the lock and does not poison the
 * ones behind it.
 */
export function withWorldLock<T>(slug: string, critical: () => Promise<T>): Promise<T> {
  const previous = _chains.get(slug)
  const result = previous ? previous.then(critical) : critical()
  // The stored tail swallows settlement so the next waiter always runs, and
  // so an unobserved rejection here can never surface as an unhandled one.
  const tail = result.then(() => {}, () => {})
  _chains.set(slug, tail)
  // Drop the entry once this section is the last one queued, so the map
  // doesn't grow one permanent promise per slug ever touched.
  void tail.then(() => {
    if (_chains.get(slug) === tail) _chains.delete(slug)
  })
  return result
}

/** Slugs with a critical section running or queued — for tests/diagnostics. */
export function heldWorldLocks(): string[] {
  return [..._chains.keys()]
}
