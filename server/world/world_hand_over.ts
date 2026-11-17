/**
 * The hand-over of scans between the worlds of two Places, as the server does it (ADR 0009): what `refreshWorldScans`
 * calls when a world no longer holds a scan, what a merge or a moved scan calls to have it done before it answers, and
 * what finishes it when it could not be done then.
 *
 * `./scan_carry.ts` decides what goes with a scan and where. This is the part that deals with the world it is going to
 * not being free, or not being readable: it puts the scans that could not be handed over back in the world they are in,
 * remembers that they are waiting, says so to the route that asked, and sees to it that the hand-over is done later without
 * anybody having to read the old world again. A factory with everything it needs from the server handed in (`WorldHandOverDeps`),
 * and no Deno or server import, so a test can stand the worlds and the clock in. `server/main.ts` makes one, and its
 * refresh and its two routes call it.
 *
 * ## What happens to a hand-over that cannot be done
 *
 * The other world's lock is only tried, never waited for (`tryWithWorldLock`): the caller of `handOver` holds the lock of
 * the world the scan leaves, and two worlds' holders that each wait for the other's lock wait for good. A busy world, or
 * one that fails to read or save, leaves the scan, with every record, in the world it was in. That world is read again:
 *
 *  - by the route that moved the scan, a few times in the first moments (`HAND_OVER_ATTEMPTS`), which covers a world that is
 *    busy for the length of one read or one write;
 *  - then on a timer that backs off (`HAND_OVER_RETRY_FIRST_MS`, doubling, `HAND_OVER_RETRIES` times), which covers a world
 *    that stays busy a while, or is repaired by somebody;
 *  - and by anybody's next read of it.
 *
 * What the route says is what it knew when it answered: `pending` counts the scans still waiting. The timer is not kept
 * across a restart: a hand-over that is still waiting when the server stops is done by the next read of the old world, and
 * until then the scan and its records are in that world, where nothing has been taken from them.
 */
import type { HandOverReport } from '../../src/world/frame-generations.ts'
import type { ScanManifest, WorldProject } from '../../src/world/types.ts'
import { type EvictedScan, handEvictedScansOver, type HandOverWorlds } from './scan_carry.ts'

/**
 * How often, and how long apart, the route that moved a scan reads the world it left while its scans are still waiting
 * for the other world. **Adopted, not measured (ADR 0005 rule 5):** a world is busy for the few milliseconds of one read
 * or one write of its file, so a handful of short waits covers it. Revisit when an answer is seen to say `pending`
 * without the world being broken.
 */
export const HAND_OVER_ATTEMPTS = 5
export const HAND_OVER_WAIT_MS = 40

/**
 * When the timer reads a world whose scans are still waiting: the first time after this many milliseconds, and each
 * time after twice as long as the one before, at most `HAND_OVER_RETRIES` times, which is about a minute in all.
 * **Adopted, not measured (ADR 0005 rule 5):** long enough for a world that is being worked on to be free, short enough
 * that a person who looks at the new Place a minute after the move finds the scan's notes there. Revisit when a hand-over
 * is seen to be still waiting after the last one.
 */
export const HAND_OVER_RETRY_FIRST_MS = 1_000
export const HAND_OVER_RETRIES = 6

/** What the hand-over needs from the server beyond the two worlds. */
export interface WorldHandOverDeps extends HandOverWorlds {
  /**
   * Reads a world as the server reads one for a request, which is what hands over the scans it no longer holds: it
   * calls `handOver` below. Rejects when the world cannot be read.
   */
  readWorld(slug: string): Promise<unknown>
  /** Waits `ms` milliseconds. */
  sleep(ms: number): Promise<void>
  /** Runs `run` once after `ms` milliseconds, without keeping the process alive for it. */
  later(run: () => void | Promise<void>, ms: number): void
  /** Says something went wrong that is not an answer to anybody. */
  warn(message: string, error?: unknown): void
}

export interface WorldHandOver {
  /**
   * For a refresh of the world `source`, under its lock: hands the scans it no longer holds over (`evicted`) and answers
   * the ones that could not be, which the caller puts back in `source.scans` to stay until the world is read again.
   */
  handOver(source: WorldProject, evicted: EvictedScan[]): Promise<ScanManifest[]>
  /**
   * For a route that has just filed scans under another Place: `held` says, for each world that held a row of one of them,
   * which scans (by file name) it held. Reads each of those worlds, which hands the scans over, and again a few times while
   * they are waiting for the other world; and arranges for them to be handed over later if they still are. Answers what the
   * route has to say about those scans, and about no others.
   */
  settle(held: ReadonlyMap<string, ReadonlySet<string>>): Promise<HandOverReport>
}

export function createWorldHandOver(deps: WorldHandOverDeps): WorldHandOver {
  /** Per world slug: the file names of the scans its last refresh could not hand over. */
  const waiting = new Map<string, Set<string>>()
  /** Per world slug: how many placement patches of each scan its last hand-over kept, by file name. */
  const kept = new Map<string, Map<string, number>>()
  /** The slugs a retry timer is running for. */
  const retrying = new Set<string>()
  /** What has been warned of, so a world that stays unreadable is said to be once and not on every read. */
  const warned = new Set<string>()

  function warnOnce(slug: string, message: string, error: unknown): void {
    const key = `${slug}\n${message}\n${error instanceof Error ? error.message : String(error)}`
    if (warned.has(key)) return
    warned.add(key)
    deps.warn(message, error)
  }

  async function handOver(source: WorldProject, evicted: EvictedScan[]): Promise<ScanManifest[]> {
    const slug = source.shareSlug
    const result = await handEvictedScansOver(source, evicted, deps)
    for (const failure of result.failures) {
      warnOnce(slug, `[worlds] could not hand scans over to the world of '${failure.projectId}'; they stay in '${slug}' until it can:`, failure.error)
    }
    if (result.stayed.length > 0) waiting.set(slug, new Set(result.stayed.map((scan) => scan.filename)))
    else waiting.delete(slug)
    for (const [filename, count] of Object.entries(result.kept)) {
      const forWorld = kept.get(slug) ?? new Map<string, number>()
      forWorld.set(filename, count)
      kept.set(slug, forWorld)
    }
    return result.stayed
  }

  const waitingIn = (slug: string, filenames: ReadonlySet<string>): string[] =>
    [...(waiting.get(slug) ?? [])].filter((filename) => filenames.has(filename))

  /** Reads the world `slug`, which hands over what it can. False when the world could not be read. */
  async function read(slug: string): Promise<boolean> {
    try {
      await deps.readWorld(slug)
      return true
    } catch (error) {
      warnOnce(slug, `[worlds] could not read '${slug}' to hand its scans over:`, error)
      return false
    }
  }

  function retryLater(slug: string): void {
    if (retrying.has(slug)) return
    retrying.add(slug)
    const tick = (attempt: number): void => {
      deps.later(async () => {
        await read(slug)
        if (waiting.has(slug) && attempt + 1 < HAND_OVER_RETRIES) tick(attempt + 1)
        else retrying.delete(slug)
      }, HAND_OVER_RETRY_FIRST_MS * 2 ** attempt)
    }
    tick(0)
  }

  async function settle(held: ReadonlyMap<string, ReadonlySet<string>>): Promise<HandOverReport> {
    const pending = new Set<string>()
    let placementsKept = 0
    for (const [slug, filenames] of held) {
      let readable = true
      for (let attempt = 0; attempt < HAND_OVER_ATTEMPTS; attempt++) {
        readable = await read(slug)
        if (!readable || waitingIn(slug, filenames).length === 0) break
        if (attempt + 1 < HAND_OVER_ATTEMPTS) await deps.sleep(HAND_OVER_WAIT_MS * (attempt + 1))
      }
      // A world that cannot be read has handed over nothing, so every scan the route filed that it held is waiting.
      const stillWaiting = readable ? waitingIn(slug, filenames) : [...filenames]
      for (const filename of stillWaiting) pending.add(filename)
      if (stillWaiting.length > 0) retryLater(slug)
      const keptHere = kept.get(slug)
      for (const filename of filenames) {
        placementsKept += keptHere?.get(filename) ?? 0
        keptHere?.delete(filename)
      }
      if (keptHere?.size === 0) kept.delete(slug)
    }
    return { ...(pending.size > 0 ? { pending: pending.size } : {}), ...(placementsKept > 0 ? { placementsKept } : {}) }
  }

  return { handOver, settle }
}

/** What a route adds to its answer for a hand-over report: nothing when there is nothing to say. */
export function handOverAnswer(report: HandOverReport): { handOver?: HandOverReport } {
  return report.pending || report.placementsKept ? { handOver: report } : {}
}
