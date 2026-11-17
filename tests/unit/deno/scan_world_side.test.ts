/**
 * What deleting a scan needs from the worlds (server/scan_world_side.ts), over a stand-in for main.ts's `mutateWorldFiles` and
 * real temporary directories for the exports.
 *
 * What these hold: a job running on the scan in any world refuses the deletion and cancels nothing anywhere; with none
 * running, the jobs waiting for the scan are taken out of each world that holds them and nothing else is; a job that starts
 * between the first look and the second is caught by the second; the finished SenseNova jobs are named; the jobs running on
 * any scan are listed for a wipe; and exports are removed for the worlds that hold the scan only (or all of them for a wipe),
 * with a failure thrown, not swallowed.
 */
import { assert, assertEquals, assertFalse, assertRejects } from 'jsr:@std/assert@^1.0.0'
import type { ScanManifest, WorldJob, WorldJobStatus, WorldJobType, WorldProject } from '../../../src/world/types.ts'
import { scanIdFor } from '../../../server/scan_id.ts'
import { scanWorldSide } from '../../../server/scan_world_side.ts'

const MINE = '100_room.glb'
const OTHER = '200_other.glb'

type FakeWorld = Pick<WorldProject, 'shareSlug' | 'scans' | 'jobs'>

let counter = 0
function job(type: WorldJobType, status: WorldJobStatus, extras: Partial<WorldJob> = {}): WorldJob {
  counter += 1
  return { jobId: `job-${counter}`, worldId: 'w', type, status, capabilities: [], createdAt: '', updatedAt: '', ...extras }
}

function world(slug: string, filenames: string[], jobs: WorldJob[]): FakeWorld {
  return { shareSlug: slug, scans: filenames.map((filename) => ({ filename, scanId: scanIdFor(filename), sessionId: null }) as unknown as ScanManifest), jobs }
}

/** main.ts's mutateWorldFiles over a list: the mutator sees each world, and a world it says it changed is counted. */
function over(worlds: FakeWorld[], between?: (pass: number) => void) {
  let pass = 0
  return {
    mutateWorldFiles: async (mutator: (world: WorldProject) => boolean | Promise<boolean>): Promise<number> => {
      between?.(pass)
      pass += 1
      let changed = 0
      for (const w of worlds) if (await mutator(w as WorldProject)) changed += 1
      return changed
    },
  }
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'scan-world-side-' })
  try {
    await run(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path)
    return true
  } catch {
    return false
  }
}

const side = (worlds: FakeWorld[], dir = '/nowhere', between?: (pass: number) => void) =>
  scanWorldSide({ ...over(worlds, between), worldExportPath: (slug) => `${dir}/${slug}.world.glb`, worldsDir: dir })

// ── Claiming a scan's jobs ──────────────────────────────────────────────────────

Deno.test('a job running on the scan refuses the deletion, and no world has any job cancelled', async () => {
  const running = job('optimize-scan', 'processing', { payload: { filename: MINE } })
  const waitingHere = job('splat-train', 'queued', { scanId: scanIdFor(MINE) })
  const waitingElsewhere = job('splat-train', 'queued', { scanId: scanIdFor(MINE) })
  const a = world('default', [MINE], [running, waitingHere])
  const b = world('project-p', [MINE], [waitingElsewhere])
  const claim = await side([a, b]).claimJobs(MINE)
  assertEquals(claim.running, [{ jobId: running.jobId, type: 'optimize-scan' }])
  assertEquals(a.jobs.map((item) => item.jobId), [running.jobId, waitingHere.jobId], 'nothing was cancelled in the world that has the running job')
  assertEquals(b.jobs.map((item) => item.jobId), [waitingElsewhere.jobId], 'nor in the other world, which the first look saw nothing running in')
})

Deno.test('with nothing running, the jobs waiting for the scan are taken out of every world, and no other job is', async () => {
  const waiting = job('splat-train', 'queued', { scanId: scanIdFor(MINE) })
  const waitingOptimize = job('optimize-scan', 'queued', { payload: { filename: MINE } })
  const finished = job('lingbot-map-reconstruct', 'completed', { scanId: scanIdFor(MINE) })
  const others = job('splat-train', 'queued', { scanId: scanIdFor(OTHER) })
  const purge = job('keyframe-purge', 'queued')
  const a = world('default', [MINE, OTHER], [waiting, waitingOptimize, finished, others, purge])
  const b = world('project-p', [MINE], [job('splat-train', 'queued', { scanId: scanIdFor(MINE) })])
  const claim = await side([a, b]).claimJobs(MINE)
  assertEquals(claim.running, [])
  assertEquals(a.jobs.map((item) => item.jobId), [finished.jobId, others.jobId, purge.jobId], 'the scan\'s waiting jobs went, a finished one and other scans\' jobs stayed')
  assertEquals(b.jobs, [], 'in every world')
})

Deno.test('a job that starts between the first look and the second is seen by the second, and its world is left as it is', async () => {
  const waiting = job('splat-train', 'queued', { scanId: scanIdFor(MINE) })
  const starting = job('lingbot-map-reconstruct', 'queued', { scanId: scanIdFor(MINE) })
  const a = world('default', [MINE], [waiting, starting])
  // The pump starts a job while the deletion is between its two looks.
  const claim = await side([a], '/nowhere', (pass) => {
    if (pass === 1) starting.status = 'processing'
  }).claimJobs(MINE)
  assertEquals(claim.running, [{ jobId: starting.jobId, type: 'lingbot-map-reconstruct' }])
  assertEquals(a.jobs.length, 2, 'the world was not changed: the caller refuses, and nothing was lost')
})

Deno.test('the finished SenseNova jobs for the scan are named, and only that scan\'s', async () => {
  const mine = job('sensenova-vision', 'completed', { scanId: scanIdFor(MINE) })
  const failed = job('sensenova-vision', 'failed', { scanId: scanIdFor(MINE) })
  const other = job('sensenova-vision', 'completed', { scanId: scanIdFor(OTHER) })
  const claim = await side([world('default', [MINE, OTHER], [mine, failed, other])]).claimJobs(MINE)
  assertEquals(claim.senseNovaJobIds.sort(), [mine.jobId, failed.jobId].sort())
})

Deno.test('the jobs running on any scan are listed for a wipe, in every world', async () => {
  const a = world('default', [MINE], [job('optimize-scan', 'processing', { payload: { filename: MINE } }), job('memory-push', 'processing')])
  const b = world('project-p', [OTHER], [job('splat-train', 'processing', { scanId: scanIdFor(OTHER) }), job('splat-train', 'queued', { scanId: scanIdFor(OTHER) })])
  const running = await side([a, b]).runningJobs()
  assertEquals(running.map((item) => item.type).sort(), ['optimize-scan', 'splat-train'])
})

// ── World exports ───────────────────────────────────────────────────────────────

Deno.test('the exports of the worlds that hold the scan are removed, and no other', async () => {
  await withDir(async (dir) => {
    for (const slug of ['default', 'project-p', 'project-q']) await Deno.writeTextFile(`${dir}/${slug}.world.glb`, `export of ${slug}`)
    const worlds = [world('default', [MINE, OTHER], []), world('project-p', [MINE], []), world('project-q', [OTHER], [])]
    assertEquals(await side(worlds, dir).dropExportsHolding(MINE), 2)
    assertFalse(await exists(`${dir}/default.world.glb`))
    assertFalse(await exists(`${dir}/project-p.world.glb`))
    assert(await exists(`${dir}/project-q.world.glb`), 'a world that never held the scan keeps its export')
    assertEquals(await side(worlds, dir).dropExportsHolding(MINE), 0, 'a world with no export is not an error')
  })
})

Deno.test('an export that cannot be removed is thrown, not swallowed, so the scan is not reported deleted', async () => {
  await withDir(async (dir) => {
    // An export that is a folder with something in it cannot be removed as a file.
    await Deno.mkdir(`${dir}/default.world.glb`)
    await Deno.writeTextFile(`${dir}/default.world.glb/inside`, 'x')
    await assertRejects(() => side([world('default', [MINE], [])], dir).dropExportsHolding(MINE))
  })
})

Deno.test('clearing every scan removes every export and nothing else, and a missing folder is no exports', async () => {
  await withDir(async (dir) => {
    for (const slug of ['default', 'project-p']) await Deno.writeTextFile(`${dir}/${slug}.world.glb`, 'x')
    await Deno.writeTextFile(`${dir}/default.json`, '{}')
    await Deno.mkdir(`${dir}/notes.world.glb.d`)
    assertEquals(await side([], dir).dropAllExports(), 2)
    assert(await exists(`${dir}/default.json`), 'a world is not an export')
    assert(await exists(`${dir}/notes.world.glb.d`))
    assertEquals(await side([], `${dir}/no-such-folder`).dropAllExports(), 0)
  })
})
