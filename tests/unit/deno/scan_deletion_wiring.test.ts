/**
 * How server/main.ts is wired to the deletion modules, read from its source, for the one thing no request can show: that
 * the pump looks at the "scan being deleted" mark after it has found a job and before it starts it (server/scan_job_guard.ts).
 * main.ts serves at import and cannot be imported, and the window this closes is a few milliseconds wide, so a request cannot
 * be made to land in it. The rest of the wiring (the routes, the finalize link, the purge's default world) is run by
 * tests/unit/deno/keyframe_routes.test.ts against the real server.
 */
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@^1.0.0'

const MAIN = await Deno.readTextFile(new URL('../../../server/main.ts', import.meta.url))

function dispatchBody(): string {
  const start = MAIN.indexOf('async function _dispatchWorldJob(')
  assert(start > 0, 'the dispatch function is where it was')
  return MAIN.slice(start, MAIN.indexOf('\n}\n', start))
}

Deno.test('the pump checks the mark under the world\'s lock, after finding the job and before it marks it processing', () => {
  const body = dispatchBody()
  const lock = body.indexOf('updateWorld(slug, (world) => {')
  const found = body.indexOf('const job = world.jobs.find(j => j.jobId === jobId)')
  const queued = body.indexOf("job.status !== 'queued') return null")
  const mark = body.indexOf('jobIsForScanBeingDeleted(job)')
  const starts = body.indexOf("job.status = 'processing'")
  assert(lock > 0 && found > lock && queued > found, 'the job is looked up inside updateWorld, which holds the world\'s lock')
  assert(mark > queued, 'the mark is read after the job is found to be queued')
  assert(starts > mark, 'and before the job is marked as processing, so a job for a scan being deleted never starts')
  assertEquals(body.split('jobIsForScanBeingDeleted(').length - 1, 1, 'one check, at the one place a job starts')
})

Deno.test('a job the pump did not start because its scan is being deleted is recorded as failed and starts nothing', () => {
  const body = dispatchBody()
  const refused = body.slice(body.indexOf('jobIsForScanBeingDeleted(job)'), body.indexOf("job.status = 'processing'"))
  assertMatch(refused, /job\.status = 'failed'/)
  assertMatch(refused, /SCAN_BEING_DELETED_NOTE/)
  assertMatch(refused, /return null/, 'the dispatch then returns without running anything')
})

Deno.test('both delete routes call the deletion module and nothing in them touches a file themselves', () => {
  const start = MAIN.indexOf('const scanWorlds = scanWorldSide(')
  assert(start > 0)
  const end = MAIN.indexOf('// ── Capture sessions — streaming keyframe ingestion')
  const routes = MAIN.slice(start, end)
  assertMatch(routes, /await deleteScan\(filename,/)
  assertMatch(routes, /await deleteAllScans\(/)
  assert(!/Deno\.(remove|readDir|stat)/.test(routes), 'the routes call the module; they remove no file themselves')
  assertMatch(routes, /scanWorldSide\(\{ mutateWorldFiles, worldExportPath, worldsDir: WORLDS_DIR \}\)/)
})
