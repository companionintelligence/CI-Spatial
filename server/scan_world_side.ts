/**
 * What deleting a scan needs from the worlds, over the world files `server/main.ts` owns: which jobs are running on the scan
 * (and the ones waiting, which it cancels), and the world exports that hold a copy of its geometry. The rules are in
 * server/scan_job_guard.ts and the order they are used in is in server/scan_deletion.ts; this is the part that touches the
 * worlds, so that main.ts only hands it the one primitive it has, `mutateWorldFiles`, and a test can hand it another.
 *
 * ## Which exports hold a copy of a scan
 *
 * An export (`<world>.world.glb`, server/world_export.ts) is a snapshot of the scans a world listed when it was built, and
 * it is not rebuilt when the world changes. A scan that was moved to another Place (a reassign, a merge) leaves the world
 * that listed it, and the export built before the move still holds the scan's geometry. So the worlds that list the scan now
 * are not the only exports that hold it: the exports say what they hold themselves. Each scan the composer puts in an export
 * is a node whose extras carry the scan's filename (and its id, which is not matched: a scan id is a lossy slug of the filename, and
 * two scans can share one), in the GLB's JSON chunk, which is read here and nothing after it. An export that cannot be read as a
 * GLB is one that cannot be shown not to hold the scan, and goes too: it is built again on request. It goes only with a scan
 * that was found, though (`DropExportsOptions.scanFound`, a world that lists the scan, an export that names it): it is no evidence
 * that the scan was ever there, so a request for a scan that is not there removes nothing, and is the 404 it was.
 *
 * `mutateWorldFiles` reads each world file inside that world's lock, runs the mutator, and writes the world back only when
 * the mutator says it changed. The lock is the one the pump takes to start a job (`_dispatchWorldJob`), so a job taken out of
 * a world here cannot start afterwards, and a job that has started is seen as running.
 */
import type { WorldProject } from '../src/world/types.ts'
import { runningScanJobs, type RunningScanJob, scanJobsInWorld } from './scan_job_guard.ts'

/** The first four bytes of a binary glTF, 'glTF', and the type of the chunk that must follow its header, 'JSON'. */
const GLB_MAGIC = 0x46546c67
const GLB_JSON_CHUNK = 0x4e4f534a
/** A binary glTF's header (12 bytes) and the header of its first chunk (8 bytes). */
const GLB_HEADERS_BYTES = 20
/**
 * The most JSON read from an export to ask what it holds. Adopted, not measured (ADR 0005 rule 5): the JSON chunk is the scene
 * graph and the accessors, a few megabytes for a Place with hundreds of scans; an export that claims more than this is not one
 * this server built, and is removed without being read.
 */
const MAX_EXPORT_JSON_BYTES = 64 * 1024 * 1024

export interface ScanWorldSideDeps {
  /** Runs `mutator` on every stored world under its lock. Resolves how many worlds it changed. */
  mutateWorldFiles(mutator: (world: WorldProject) => boolean | Promise<boolean>): Promise<number>
  /** Where a world's export is written (`<world>.world.glb`). */
  worldExportPath(slug: string): string
  /** The folder the worlds and their exports live in. */
  worldsDir: string
}

export interface DropExportsOptions {
  /**
   * Whether the deletion has found something of the scan itself, before it asks: its files, or the camera frames only it names.
   * Without it, an export that cannot be read as a GLB is removed only when something else finds the scan: a world that lists it,
   * or an export that names it. An export that cannot be read is not evidence of a scan, so for a scan that nothing was found of
   * (a name that never was a scan here) nothing is removed. False when left out.
   */
  scanFound?: boolean
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
  /**
   * Removes every export that holds a copy of the scan: the exports of the worlds that list it now, and the exports that
   * say they hold it whatever world they came from (a world the scan was moved out of, or one that has gone); and, when the
   * scan was found, the exports that cannot be read, which cannot be shown not to hold it. Resolves how many it removed.
   * Throws when one cannot be read or removed.
   */
  dropExportsHolding(filename: string, options?: DropExportsOptions): Promise<number>
  /** Removes every world export, for the call that clears all scans. Resolves how many. Throws when one cannot be removed. */
  dropAllExports(): Promise<number>
}

/** Reads up to `length` bytes from where `file` is, fewer when it ends first. */
async function readUpTo(file: Deno.FsFile, length: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(length)
  let got = 0
  while (got < length) {
    const n = await file.read(bytes.subarray(got))
    if (n === null) break
    got += n
  }
  return bytes.subarray(0, got)
}

/**
 * Whether the export at `path` holds one of `needles` (JSON-quoted strings: a filename) in its JSON chunk. `gone` when
 * there is no such file; `unreadable` when it is not a binary glTF whose first chunk is JSON of a size this reads. Only
 * the two headers and that chunk are read, never the geometry after it. A read that fails is thrown.
 */
async function exportHolds(path: string, needles: readonly string[]): Promise<'holds' | 'does-not' | 'unreadable' | 'gone'> {
  let file: Deno.FsFile
  try {
    file = await Deno.open(path, { read: true })
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 'gone'
    throw error
  }
  try {
    const headers = await readUpTo(file, GLB_HEADERS_BYTES)
    if (headers.length < GLB_HEADERS_BYTES) return 'unreadable'
    const view = new DataView(headers.buffer, headers.byteOffset, headers.byteLength)
    if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(16, true) !== GLB_JSON_CHUNK) return 'unreadable'
    const length = view.getUint32(12, true)
    if (length > MAX_EXPORT_JSON_BYTES) return 'unreadable'
    const chunk = await readUpTo(file, length)
    if (chunk.length < length) return 'unreadable'
    const text = new TextDecoder().decode(chunk)
    return needles.some((needle) => text.includes(needle)) ? 'holds' : 'does-not'
  } finally {
    file.close()
  }
}

export function scanWorldSide(deps: ScanWorldSideDeps): ScanWorldSide {
  /** Removes the file at `path`. Resolves whether there was one. A path that is already gone is not an error. */
  async function removePath(path: string): Promise<boolean> {
    try {
      await Deno.remove(path)
      return true
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false
      throw error
    }
  }

  /** Removes a world's export. Resolves whether there was one. */
  const removeExport = (slug: string): Promise<boolean> => removePath(deps.worldExportPath(slug))

  /** The names of the files in the worlds folder that are exports. A folder that is not there has none. */
  async function exportFileNames(): Promise<string[]> {
    const names: string[] = []
    try {
      for await (const entry of Deno.readDir(deps.worldsDir)) {
        if (entry.isFile && entry.name.endsWith('.world.glb')) names.push(entry.name)
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return []
      throw error
    }
    return names
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

    async dropExportsHolding(filename, options = {}) {
      // The exports that hold the scan, or that a world which lists it points to (whether or not that export is there).
      const holding = new Set<string>()
      await deps.mutateWorldFiles((world) => {
        if (world.scans.some((scan) => scan.filename === filename)) holding.add(deps.worldExportPath(world.shareSlug))
        return false
      })
      // The exports the worlds do not point to: a world that no longer lists the scan can still have an export that holds it.
      const unreadable = new Set<string>()
      const needles = [JSON.stringify(filename)]
      for (const name of await exportFileNames()) {
        const path = `${deps.worldsDir}/${name}`
        if (holding.has(path)) continue
        const held = await exportHolds(path, needles)
        if (held === 'holds') holding.add(path)
        else if (held === 'unreadable') unreadable.add(path)
      }
      // An export that cannot be read cannot be shown not to hold the scan, so it goes with a scan that was found: by the
      // deletion (its files), by a world that lists it or by an export that names it. It is never the evidence: for a name
      // nothing was found of, no export is removed. They go first, so that a removal that fails leaves the exports that name the
      // scan, and a second try, which no longer has the scan's files, finds the scan through them and takes the rest. (A second
      // try after the removal of an export that cannot be read failed, with nothing else of the scan left, finds nothing of it.)
      const found = options.scanFound === true || holding.size > 0
      const paths = found ? [...unreadable, ...holding] : []
      let removed = 0
      for (const path of paths) if (await removePath(path)) removed += 1
      return removed
    },

    async dropAllExports() {
      const slugs = (await exportFileNames()).map((name) => name.slice(0, -'.world.glb'.length))
      let removed = 0
      for (const slug of slugs) if (await removeExport(slug)) removed += 1
      return removed
    },
  }
}
