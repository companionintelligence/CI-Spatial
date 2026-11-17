/**
 * What deleting a scan needs from the worlds, over the world files `server/main.ts` owns: which jobs are running on the scan
 * (and the ones waiting, which it cancels), and the world exports that hold a copy of its geometry. The rules are in
 * server/scan_job_guard.ts and the order they are used in is in server/scan_deletion.ts; this is the part that touches the
 * worlds, so that main.ts only hands it the one primitive it has, `mutateWorldFiles`, and a test can hand it another.
 *
 * `mutateWorldFiles` reads each world file inside that world's lock, runs the mutator, and writes the world back only when
 * the mutator says it changed. The lock is the one the pump takes to start a job (`_dispatchWorldJob`), so a job taken out of
 * a world here cannot start afterwards, and a job that has started is seen as running.
 */
import type { WorldProject } from '../src/world/types.ts'
import { runningScanJobs, type RunningScanJob, scanJobsInWorld } from './scan_job_guard.ts'

export interface ScanWorldSideDeps {
  /** Runs `mutator` on every stored world under its lock. Resolves how many worlds it changed. */
  mutateWorldFiles(mutator: (world: WorldProject) => boolean | Promise<boolean>): Promise<number>
  /** Where a world's export is written (`<world>.world.glb`). */
  worldExportPath(slug: string): string
  /** The folder the worlds and their exports live in. */
  worldsDir: string
}

export interface ScanWorldSide {
  /**
   * Before a scan's files go: reports the jobs running on it, in every world, and cancels the ones still waiting. A refusal
   * cancels nothing: the first pass only looks, and the second runs only when nothing is running. Also names the finished
   * SenseNova jobs, each of which wrote a folder.
   */
  claimJobs(filename: string): Promise<{ running: RunningScanJob[]; senseNovaJobIds: string[] }>
  /** The jobs running on any scan, in every world. */
  runningJobs(): Promise<RunningScanJob[]>
  /** Removes the exports of the worlds that hold the scan. Resolves how many. Throws when one cannot be removed. */
  dropExportsHolding(filename: string): Promise<number>
  /** Removes every world export, for the call that clears all scans. Resolves how many. Throws when one cannot be removed. */
  dropAllExports(): Promise<number>
}

export function scanWorldSide(deps: ScanWorldSideDeps): ScanWorldSide {
  /** Removes a world's export. Resolves whether there was one. A path that is already gone is not an error. */
  async function removeExport(slug: string): Promise<boolean> {
    try {
      await Deno.remove(deps.worldExportPath(slug))
      return true
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false
      throw error
    }
  }

  return {
    async claimJobs(filename) {
      const claim: { running: RunningScanJob[]; senseNovaJobIds: string[] } = { running: [], senseNovaJobIds: [] }
      await deps.mutateWorldFiles((world) => {
        claim.running.push(...scanJobsInWorld(world, filename).running)
        return false
      })
      if (claim.running.length > 0) return claim
      await deps.mutateWorldFiles((world) => {
        const found = scanJobsInWorld(world, filename)
        claim.running.push(...found.running)
        claim.senseNovaJobIds.push(...found.senseNovaJobIds)
        // A job that started between the two passes is running now: leave this world as it is, and let the caller refuse.
        if (found.running.length > 0 || found.waiting.length === 0) return false
        const cancelled = new Set(found.waiting)
        world.jobs = world.jobs.filter((job) => !cancelled.has(job.jobId))
        return true
      })
      return claim
    },

    async runningJobs() {
      const running: RunningScanJob[] = []
      await deps.mutateWorldFiles((world) => {
        running.push(...runningScanJobs(world.jobs))
        return false
      })
      return running
    },

    async dropExportsHolding(filename) {
      const slugs: string[] = []
      await deps.mutateWorldFiles((world) => {
        if (world.scans.some((scan) => scan.filename === filename)) slugs.push(world.shareSlug)
        return false
      })
      let removed = 0
      for (const slug of slugs) if (await removeExport(slug)) removed += 1
      return removed
    },

    async dropAllExports() {
      const slugs: string[] = []
      try {
        for await (const entry of Deno.readDir(deps.worldsDir)) {
          if (entry.isFile && entry.name.endsWith('.world.glb')) slugs.push(entry.name.slice(0, -'.world.glb'.length))
        }
      } catch (error) {
        // No worlds folder, no exports.
        if (error instanceof Deno.errors.NotFound) return 0
        throw error
      }
      let removed = 0
      for (const slug of slugs) if (await removeExport(slug)) removed += 1
      return removed
    },
  }
}
