/**
 * Keeping a scan's deletion and the jobs that work on it apart (server/scan_job_guard.ts).
 *
 * What these hold: which jobs a deletion waits for (the ones running on the scan, by the id it goes by, by its
 * filename for the optimizer's job which carries no id, and an export of a world that holds it), which it cancels (the
 * ones still waiting), which finished SenseNova jobs left a folder to remove, and that nothing else is touched; and the mark
 * the pump looks at before it starts a job: raised for a scan being deleted, counted, lifted exactly once.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1.0.0'
import type { ScanManifest, WorldJob, WorldJobStatus, WorldJobType, WorldProject } from '../../../src/world/types.ts'
import { legacyScanId, scanIdFor } from '../../../server/scan_id.ts'
import {
  jobIsForScanBeingDeleted,
  markEveryScanBeingDeleted,
  markScansBeingDeleted,
  runningScanJobs,
  scanIdsInWorld,
  scanJobsInWorld,
} from '../../../server/scan_job_guard.ts'

const MINE = '100_room.glb'
const OTHER = '200_other.glb'
const SESSION = 'sess-11111111-1111-4111-8111-111111111111'

function scan(filename: string, sessionId: string | null = null): ScanManifest {
  return { filename, scanId: scanIdFor(filename), sessionId } as unknown as ScanManifest
}

let counter = 0
function job(type: WorldJobType, status: WorldJobStatus, extras: Partial<WorldJob> = {}): WorldJob {
  counter += 1
  return { jobId: `job-${counter}`, worldId: 'world-x', type, status, capabilities: [], createdAt: '', updatedAt: '', ...extras }
}

function world(scans: ScanManifest[], jobs: WorldJob[]): Pick<WorldProject, 'scans' | 'jobs'> {
  return { scans, jobs }
}

// ── Which jobs bear on a deletion ───────────────────────────────────────────────

Deno.test('a job running on the scan is one the deletion waits for, whichever way it names the scan', () => {
  const byId = job('lingbot-map-reconstruct', 'processing', { scanId: scanIdFor(MINE) })
  const byFilename = job('optimize-scan', 'processing', { payload: { filename: MINE } })
  const legacy = job('splat-train', 'processing', { scanId: legacyScanId({ filename: MINE, sessionId: SESSION }) })
  const w = world([scan(MINE, SESSION)], [byId, byFilename, legacy])
  const found = scanJobsInWorld(w, MINE)
  assertEquals(found.running.map((item) => item.jobId).sort(), [byId.jobId, byFilename.jobId, legacy.jobId].sort())
  assertEquals(found.running.find((item) => item.jobId === byFilename.jobId)?.type, 'optimize-scan')
  assertEquals(found.waiting, [])
})

Deno.test('a reply names a running job by its id and type and nothing from its payload', () => {
  const running = job('optimize-scan', 'processing', { payload: { filename: MINE, secret: 'x' } })
  const found = scanJobsInWorld(world([scan(MINE)], [running]), MINE)
  assertEquals(found.running, [{ jobId: running.jobId, type: 'optimize-scan' }])
})

Deno.test('a job waiting for its turn is cancelled, and a finished or another scan\'s job is left alone', () => {
  const waiting = job('splat-train', 'queued', { scanId: scanIdFor(MINE) })
  const waitingOptimize = job('optimize-scan', 'queued', { payload: { filename: MINE } })
  const done = job('lingbot-map-reconstruct', 'completed', { scanId: scanIdFor(MINE) })
  const failed = job('colmap-poses', 'failed', { scanId: scanIdFor(MINE) })
  const others = job('optimize-scan', 'processing', { payload: { filename: OTHER } })
  const othersWaiting = job('splat-train', 'queued', { scanId: scanIdFor(OTHER) })
  const worldless = job('memory-push', 'processing')
  const w = world([scan(MINE), scan(OTHER)], [waiting, waitingOptimize, done, failed, others, othersWaiting, worldless])
  const found = scanJobsInWorld(w, MINE)
  assertEquals(found.waiting.sort(), [waiting.jobId, waitingOptimize.jobId].sort())
  assertEquals(found.running, [], 'no job is running on this scan, so the deletion goes ahead')
})

Deno.test('an export of a world that holds the scan is waited for, and an export elsewhere is not', () => {
  const exporting = job('export-world', 'processing')
  const queued = job('export-world', 'queued')
  assertEquals(scanJobsInWorld(world([scan(MINE)], [exporting, queued]), MINE).running, [{ jobId: exporting.jobId, type: 'export-world' }])
  assertEquals(scanJobsInWorld(world([scan(MINE)], [exporting, queued]), MINE).waiting, [], 'a queued export is not cancelled: it reads the scans left')
  assertEquals(scanJobsInWorld(world([scan(OTHER)], [exporting]), MINE).running, [], 'a world that does not hold the scan is not exported from it')
})

Deno.test('a finished SenseNova job for the scan leaves a folder to remove, and no other job does', () => {
  const finished = job('sensenova-vision', 'completed', { scanId: scanIdFor(MINE) })
  const skipped = job('sensenova-vision', 'failed', { scanId: scanIdFor(MINE) })
  const elsewhere = job('sensenova-vision', 'completed', { scanId: scanIdFor(OTHER) })
  const lingbot = job('lingbot-map-reconstruct', 'completed', { scanId: scanIdFor(MINE) })
  const found = scanJobsInWorld(world([scan(MINE), scan(OTHER)], [finished, skipped, elsewhere, lingbot]), MINE)
  assertEquals(found.senseNovaJobIds.sort(), [finished.jobId, skipped.jobId].sort())
})

Deno.test('a scan is known by the id its filename gives, the one its row carries, and the one it carried before', () => {
  const row = scan(MINE, SESSION)
  const ids = scanIdsInWorld({ scans: [row] }, MINE)
  assertEquals([...ids].sort(), [...new Set([scanIdFor(MINE), row.scanId, legacyScanId(row)])].sort())
  assert(ids.has(legacyScanId({ filename: MINE, sessionId: SESSION })))
  assertEquals([...scanIdsInWorld({ scans: [] }, MINE)], [scanIdFor(MINE)], 'a world that does not hold the scan still knows its derived id')
})

Deno.test('the jobs running on any scan are the ones that name a scan, the optimizer\'s by its filename', () => {
  const jobs = [
    job('lingbot-map-reconstruct', 'processing', { scanId: scanIdFor(MINE) }),
    job('optimize-scan', 'processing', { payload: { filename: OTHER } }),
    job('optimize-scan', 'queued', { payload: { filename: OTHER } }),
    job('keyframe-purge', 'processing'),
    job('memory-push', 'processing'),
    job('export-world', 'processing'),
    job('splat-train', 'completed', { scanId: scanIdFor(MINE) }),
  ]
  assertEquals(runningScanJobs(jobs).map((item) => item.type).sort(), ['lingbot-map-reconstruct', 'optimize-scan'])
})

// ── The mark the pump looks at ──────────────────────────────────────────────────

Deno.test('a scan being deleted is marked by its id and its filename, and the mark is lifted exactly once', () => {
  const byId = { scanId: scanIdFor(MINE) }
  const byFilename = { payload: { filename: MINE } }
  assertFalse(jobIsForScanBeingDeleted(byId))
  const lift = markScansBeingDeleted([scanIdFor(MINE), MINE])
  assert(jobIsForScanBeingDeleted(byId), 'a job that names the scan by its id must not start')
  assert(jobIsForScanBeingDeleted(byFilename), 'nor one that names it by its filename (the optimizer\'s)')
  assertFalse(jobIsForScanBeingDeleted({ scanId: scanIdFor(OTHER), payload: { filename: OTHER } }), 'another scan\'s job is not held up')
  assertFalse(jobIsForScanBeingDeleted({}), 'a job that names no scan is never held up')
  lift()
  assertFalse(jobIsForScanBeingDeleted(byId))
  assertFalse(jobIsForScanBeingDeleted(byFilename))
  lift() // a second lift is harmless and does not go below nothing
  assertFalse(jobIsForScanBeingDeleted(byId))
})

Deno.test('two deletions of one scan at once do not lift each other\'s mark', () => {
  const byId = { scanId: scanIdFor(MINE) }
  const first = markScansBeingDeleted([scanIdFor(MINE)])
  const second = markScansBeingDeleted([scanIdFor(MINE)])
  first()
  first()
  assert(jobIsForScanBeingDeleted(byId), 'the second deletion is still under way')
  second()
  assertFalse(jobIsForScanBeingDeleted(byId))
})

Deno.test('clearing every scan marks every job that names a scan, and no job that names none', () => {
  const lift = markEveryScanBeingDeleted()
  assert(jobIsForScanBeingDeleted({ scanId: scanIdFor(MINE) }))
  assert(jobIsForScanBeingDeleted({ payload: { filename: OTHER } }))
  assertFalse(jobIsForScanBeingDeleted({}), 'a purge or an export names no scan and is not held up')
  assertFalse(jobIsForScanBeingDeleted({ payload: { dryRun: true } }))
  lift()
  assertFalse(jobIsForScanBeingDeleted({ scanId: scanIdFor(MINE) }))
})
