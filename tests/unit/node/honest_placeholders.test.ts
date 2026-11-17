/**
 * Jobs that do nothing must not look as if they did something.
 *
 * Six `WorldJobType`s have no worker (`ingest`, `extract-layers`, `align-scan`, `merge-points`,
 * `semantic-pass`, `depth-reconstruct`): the pump sleeps 650 ms, checks an input, writes a sentence and a
 * report artifact, and completes. Before this change the sentences read like outcomes ("Alignment recorded
 * from current world transform"), `align-scan` stamped the scan `'aligned'`, the editor's guided Prepare step
 * queued it under the words "check alignment", the quality panel said "Improving your scan - aligning", and the
 * job list showed only `completed`. A person who pressed Prepare saw a green result for a step that moved
 * nothing. The owner's standing problem is that scans do not line up, so a button that reads as alignment and
 * is not one is worse than no button.
 *
 * What runs for real: the sentences and the label function are pure and are run. `server/main.ts` and
 * `src/viewer/viewer.ts` cannot be imported under node (one starts a server, the other draws a scene), so
 * their wiring is read as source, the way calibration_fields.test.ts and alignment_status.test.ts read theirs.
 * Those tests are named "source shape:" and claim no behaviour: that a job's result paints in a browser is for
 * the browser specs, which the integrator runs.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/honest_placeholders.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALIGN_SCAN_NEEDS_TWO_SCANS,
  NO_OP_PREFIX,
  PLACEHOLDER_JOB_TYPES,
  healPlaceholderJobs,
  honestPlaceholderText,
  isPlaceholderJobType,
  jobOutcomeText,
  placeholderJobResult,
  type PlaceholderJobFields,
} from '../../../src/shared/placeholder-jobs.ts'
import { jobRowMarkup } from '../../../src/viewer/job-row.ts'
import { jobProcessingLabel } from '../../../src/viewer/quality-tier.ts'
import type { WorldJob, WorldJobStatus, WorldJobType } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/** Block comments and `//` comments out, so a test about code is not satisfied or broken by a sentence about it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** One top-level function's text: from its header to the first closing brace in column zero. */
function functionSource(source: string, header: string): string {
  const start = source.indexOf(header)
  assert.ok(start !== -1, `no function with this header: ${header}`)
  const end = source.indexOf('\n}\n', start)
  assert.ok(end !== -1, `the function with this header does not close: ${header}`)
  return source.slice(start, end)
}

/** Every member of the `WorldJobType` union, read from the file that declares it. */
function worldJobTypes(): WorldJobType[] {
  const types = read('src/world/types.ts')
  const start = types.indexOf('export type WorldJobType =')
  const end = types.indexOf('export type WorldJobStatus')
  assert.ok(start !== -1 && end > start, 'the WorldJobType union moved')
  return [...types.slice(start, end).matchAll(/^\s*\| '([a-z0-9-]+)'/gm)].map((m) => m[1] as WorldJobType)
}

const SIX: WorldJobType[] = ['ingest', 'extract-layers', 'align-scan', 'merge-points', 'semantic-pass', 'depth-reconstruct']

// ── The sentences ────────────────────────────────────────────────────────────────────────────

test('the jobs with no worker are exactly these six, and no job with a worker is listed', () => {
  assert.deepEqual([...PLACEHOLDER_JOB_TYPES].sort(), [...SIX].sort())
  for (const type of SIX) assert.equal(isPlaceholderJobType(type), true, type)
  for (const type of worldJobTypes().filter((t) => !SIX.includes(t))) assert.equal(isPlaceholderJobType(type), false, `${type} has a worker`)
})

test('a completed placeholder says No-op first, and then what was not done, as its first words', () => {
  for (const type of PLACEHOLDER_JOB_TYPES) {
    const result = placeholderJobResult(type)
    assert.ok(result.startsWith(NO_OP_PREFIX), `${type}: ${result}`)
    assert.equal(NO_OP_PREFIX, 'No-op:')
    // "No-op: no points were merged." / "No-op: nothing was ingested.": the first clause is the negation. A sentence that
    // begins by saying something ran or was queued ("semantic pass ran and found 12 objects") is the old kind of claim
    // behind a prefix, which is worse than none.
    assert.match(result, /^No-op: (no|nothing) /, `${type} must begin by saying what was not done: ${result}`)
  }
  assert.match(placeholderJobResult('align-scan'), /no alignment was computed and no scan was moved/)
  assert.match(placeholderJobResult('merge-points'), /no points were merged/)
})

test('none of the old sentences, which each claimed an outcome, survive', () => {
  const OLD_CLAIMS = /recorded|indexed|validated|queued through|can refine|is available from|resolved|attach here|attach to this job/i
  for (const type of PLACEHOLDER_JOB_TYPES) assert.doesNotMatch(placeholderJobResult(type), OLD_CLAIMS, type)
})

test('a sentence names no worker that does not exist, no future worker, and no capability the job lacks', () => {
  for (const type of PLACEHOLDER_JOB_TYPES) {
    assert.doesNotMatch(placeholderJobResult(type), /Open3D|GPU|Depth Anything|WebXR depth/i, type)
    assert.doesNotMatch(placeholderJobResult(type), /\b(will|queued|attach|worker will|later)\b/i, `${type} promises something the job does not do`)
  }
})

test('a sentence is one short line the job list can show: under 200 characters, no line breaks', () => {
  for (const type of PLACEHOLDER_JOB_TYPES) {
    const result = placeholderJobResult(type)
    assert.ok(result.length < 200, `${type} is ${result.length} characters`)
    assert.doesNotMatch(result, /\n/)
  }
})

// ── Which jobs have no worker: read from the dispatcher, so the list cannot go stale ─────────

test('source shape: the types the pump dispatches no runner for are exactly the ones listed', () => {
  const dispatcher = code(functionSource(read('server/main.ts'), 'async function _dispatchWorldJob('))
  const withRunner = new Set([...dispatcher.matchAll(/job\.type === '([a-z0-9-]+)'/g)].map((m) => m[1]!))
  const without = worldJobTypes().filter((type) => !withRunner.has(type)).sort()
  assert.deepEqual(without, [...PLACEHOLDER_JOB_TYPES].sort(),
    'a type got a runner (its "No-op:" sentence is now false) or a type reached the placeholder path unlisted')
})

test('source shape: jobResultFor takes the six sentences from one place, and the placeholder path still calls it', () => {
  const main = code(read('server/main.ts'))
  const result = functionSource(main, 'function jobResultFor(')
  assert.match(result, /case 'ingest':\s*case 'extract-layers':\s*case 'align-scan':\s*case 'merge-points':\s*case 'semantic-pass':\s*case 'depth-reconstruct':\s*return placeholderJobResult\(job\.type\)/)
  assert.match(main, /import \{[^}]*\bplaceholderJobResult\b[^}]*\} from '\.\.\/src\/shared\/placeholder-jobs\.ts'/)
  const dispatcher = functionSource(main, 'async function _dispatchWorldJob(')
  assert.match(dispatcher, /currentJob\.result = jobResultFor\(currentJob\)/, 'the generic completion path writes the result jobResultFor gives')
  for (const old of ['Alignment recorded', 'Scan ingest indexed', 'Layer index is available', 'Point merge plan recorded', 'Semantic pass queued', 'Depth reconstruction inputs validated']) {
    assert.ok(!read('server/main.ts').includes(old), `server/main.ts still says "${old}"`)
  }
})

// ── No 'aligned' ─────────────────────────────────────────────────────────────────────────────

test('source shape: completing a job with no worker writes no status on the scan, and nothing writes aligned', () => {
  const apply = code(functionSource(read('server/main.ts'), 'function applyCompletedJobToWorld('))
  assert.doesNotMatch(apply, /'aligned'/, "applyCompletedJobToWorld still writes 'aligned'")
  // The six compute nothing, so they have no outcome to record. Three of them (semantic-pass, extract-layers,
  // merge-points) used to set the status again from the capture's quality, which cleared a needs-rescan or needs-review
  // verdict that no job had re-judged. The header of src/shared/placeholder-jobs.ts says no scan is changed.
  for (const type of PLACEHOLDER_JOB_TYPES) {
    assert.doesNotMatch(apply, new RegExp(`job\\.type === '${type}'`), `${type} has an outcome on the scan again`)
  }
  assert.match(apply, /job\.type === 'lingbot-map-reconstruct'/, 'the jobs with a worker still record theirs')

  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const path = `${dir}/${name}`
      if (statSync(join(ROOT, path)).isDirectory()) walk(path)
      else if (/\.ts$/.test(name) && /(?:status|Status)\s*[:=]\s*['"]aligned['"]/.test(code(read(path)))) offenders.push(path)
    }
  }
  walk('server')
  walk('src')
  assert.deepEqual(offenders, [], "something assigns a scan status of 'aligned'")
})

test("source shape: a scan with no GLB on disk no longer keeps an 'aligned' an older build wrote", () => {
  const refresh = code(read('server/main.ts'))
  assert.match(refresh, /if \(scan\.status === 'ready' \|\| scan\.status === 'aligned'\) \{\s*changed = true\s*return \{ \.\.\.scan, status: 'processing' as const \}/)
})

test("the 'aligned' status member stays in the type, so world files an older build wrote still load", () => {
  assert.match(read('src/world/types.ts'), /export type ScanManifestStatus = ScanReviewStatus \| 'processing' \| 'aligned' \| 'error'/)
})

// ── The editor ───────────────────────────────────────────────────────────────────────────────

test('source shape: the guided Prepare step no longer queues align-scan, and no guided step does', () => {
  const viewer = read('src/viewer/viewer.ts')
  const block = viewer.slice(viewer.indexOf('const GUIDED_WORKFLOWS'), viewer.indexOf('async function queueGuidedWorkflow'))
  const steps = Object.fromEntries(
    [...block.matchAll(/^\s*(\w+): \[([^\]]*)\]/gm)].map((m) => [m[1]!, [...m[2]!.matchAll(/'([a-z0-9-]+)'/g)].map((t) => t[1]!)]),
  )
  assert.deepEqual(steps['prepare'], ['ingest', 'extract-layers'])
  assert.deepEqual(Object.keys(steps).sort(), ['prepare', 'publish', 'reconstruct', 'understand'])
  const known = new Set(worldJobTypes())
  for (const [step, types] of Object.entries(steps)) {
    assert.ok(!types.includes('align-scan'), `${step} queues align-scan`)
    for (const type of types) assert.ok(known.has(type as WorldJobType), `${step}: ${type} is not a job type`)
  }
})

/** The guided steps the editor has, with the job types each queues, read from viewer.ts. */
function guidedSteps(): Record<string, string[]> {
  const viewer = read('src/viewer/viewer.ts')
  const block = viewer.slice(viewer.indexOf('const GUIDED_WORKFLOWS'), viewer.indexOf('async function queueGuidedWorkflow'))
  return Object.fromEntries(
    [...block.matchAll(/^\s*(\w+): \[([^\]]*)\]/gm)].map((m) => [m[1]!, [...m[2]!.matchAll(/'([a-z0-9-]+)'/g)].map((t) => t[1]!)]),
  )
}

/** The sentence under each guided step's name in viewer.html. */
function guidedCopy(): Record<string, string> {
  const html = read('viewer.html')
  return Object.fromEntries(
    [...html.matchAll(/<div class="processing-step"><div><strong>\d\. (\w+)<\/strong><span>([^<]*)<\/span>/g)].map((m) => [m[1]!.toLowerCase(), m[2]!]),
  )
}

test('source shape: a guided step that queues a job with no worker says in its own words that it is not built, and no other step does', () => {
  // The brief for this change prescribed "Index media and extract layers" for Prepare. Both of its jobs are placeholders
  // (their results say "No-op:"), so the button read as a promise the job list then contradicted one row below it.
  const steps = guidedSteps()
  const copy = guidedCopy()
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(steps).sort(), 'every guided step has copy in viewer.html')
  for (const [step, types] of Object.entries(steps)) {
    const placeholders = types.filter((type) => isPlaceholderJobType(type as WorldJobType))
    if (placeholders.length > 0) {
      assert.match(copy[step]!, /\bnot built yet\b/i, `${step} queues ${placeholders.join(', ')}, which have no worker, and its copy does not say so: ${copy[step]}`)
      assert.match(copy[step]!, /\bno-op\b/i, `${step}: the job list says "No-op:", so the copy tells the person what they will see`)
    } else {
      assert.doesNotMatch(copy[step]!, /not built yet|no-op/i, `${step} queues only jobs that work, and says they do not: ${copy[step]}`)
    }
  }
})

test('source shape: the guided copy no longer claims a result the jobs it queues do not produce', () => {
  const copy = guidedCopy()
  assert.doesNotMatch(copy['prepare']!, /align/i, 'the old copy said it checked alignment')
  assert.doesNotMatch(copy['prepare']!, /^Index media/i)
  assert.doesNotMatch(copy['understand']!, /^Run semantic analysis/i)
  assert.match(copy['understand']!, /durable Things/, 'thing-correspondence is a real job and is still named')
  assert.doesNotMatch(read('viewer.html'), /check alignment/i)
})

test('source shape: the advanced job menu no longer offers Align scan, and still offers every job the guided steps and the other menu entries need', () => {
  const html = read('viewer.html')
  const menu = /<select class="ci-select ci-select-block" id="job-type"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1]
  assert.ok(menu, 'the job menu moved')
  const offered = [...menu.matchAll(/<option value="([a-z0-9-]+)">/g)].map((m) => m[1]!)
  assert.ok(!offered.includes('align-scan'), 'the menu offers a job that registers nothing under a name that says it does')
  const known = new Set(worldJobTypes())
  for (const type of offered) assert.ok(known.has(type as WorldJobType), `${type} is not a job type`)
  for (const type of ['ingest', 'extract-layers', 'merge-points', 'semantic-pass', 'depth-reconstruct', 'lingbot-map-reconstruct', 'splat-train']) {
    assert.ok(offered.includes(type), `${type} is gone from the menu: only align-scan was meant to go`)
  }
})

test("source shape: the job list is drawn by the job-row module, with the viewer's escape, and its text is clamped in the CSS", () => {
  const viewer = read('src/viewer/viewer.ts')
  assert.match(viewer, /import \{ jobRowMarkup \} from '\.\/job-row'/)
  const render = functionSource(viewer, 'function renderJobs(')
  assert.match(render, /row\.innerHTML = jobRowMarkup\(\s*job,\s*scanName,\s*new Date\(job\.updatedAt\)\.toLocaleTimeString\(undefined, \{ hour: '2-digit', minute: '2-digit' \}\),\s*escHtml,\s*\)/)
  assert.match(read('viewer.html'), /\.job-result \{[^}]*-webkit-line-clamp: 3/, 'a long sentence is clamped, not allowed to push the list off screen')
})

// ── The job row, run ─────────────────────────────────────────────────────────────────────────

const mark = (text: string) => `«${text}»`
const realEscape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const job = (over: Partial<PlaceholderJobFields> & { status: WorldJobStatus }): PlaceholderJobFields => ({ type: 'align-scan', ...over })

test('a job row prints the outcome sentence under the status, and as the row title', () => {
  const html = jobRowMarkup(job({ status: 'completed', result: placeholderJobResult('align-scan') }), 'Kitchen', '10:00', mark)
  assert.ok(html.includes('<div class="job-title">«align-scan»</div>'))
  assert.ok(html.includes('<div class="job-meta">«completed» · «Kitchen»</div>'))
  assert.ok(html.includes(`<div class="job-meta job-result" title="«${placeholderJobResult('align-scan')}»">«${placeholderJobResult('align-scan')}»</div>`))
  assert.ok(html.includes('<span class="job-meta">«10:00»</span>'))
})

test('a job row draws every piece of text through the escape it is given, the title attribute included', () => {
  const hostile = '"><img src=x onerror=alert(1)>'
  const html = jobRowMarkup(
    { type: 'splat-train', status: 'failed', result: hostile, error: hostile },
    hostile,
    hostile,
    realEscape,
  )
  assert.doesNotMatch(html, /<img|"><|onerror=alert\(1\)>/, html)
  assert.equal(html.match(/</g)?.length, 10, "only the row's own four divs and span, each opened and closed, are tags")
  const marked = jobRowMarkup({ type: 'splat-train', status: 'failed', result: 'R', error: 'E' }, 'S', 'T', mark)
  for (const piece of ['«splat-train»', '«failed»', '«S»', '«R»', '«T»']) assert.ok(marked.includes(piece), `${piece} is not escaped`)
  assert.equal(marked.split('«R»').length - 1, 2, 'the outcome is escaped in the title and in the text')
})

test('a job row with nothing to say prints no outcome line, and a failed job prints its reason', () => {
  assert.doesNotMatch(jobRowMarkup(job({ status: 'queued' }), null, '10:00', mark), /job-result/)
  assert.doesNotMatch(jobRowMarkup(job({ status: 'processing', result: '   ' }), null, '10:00', mark), /job-result/, 'blank is nothing')
  const failed = jobRowMarkup({ type: 'splat-train', status: 'failed', error: 'splat-train requires a selected scan.' }, null, '10:00', mark)
  assert.match(failed, /job-result" title="«splat-train requires a selected scan\.»"/)
  assert.doesNotMatch(jobRowMarkup(job({ status: 'queued' }), undefined, '10:00', mark), / · «/, 'no scan name, no separator')
})

// ── Jobs an older build already completed ────────────────────────────────────────────────────

/** The sentences each of the six carried before this change, as worlds on disk still hold them. */
const OLDER_BUILD_SENTENCES: Record<string, string> = {
  ingest: 'Scan ingest indexed GLB metadata, quality summary, layers, and sidecar references.',
  'extract-layers': 'Layer index is available from GLB extras, scene graph conventions, and sidecar manifests.',
  'align-scan': 'Alignment recorded from current world transform. A GPU/Open3D worker can refine this with registration artifacts.',
  'merge-points': 'Point merge plan recorded. A worker should replace this with a merged cloud artifact.',
  'semantic-pass': 'Semantic pass queued through the local coordinator. Server masks/detections can attach to this job artifact.',
  'depth-reconstruct': 'Depth reconstruction inputs validated. Depth Anything or WebXR depth artifacts can attach here.',
}

test('a placeholder job an older build completed with a claim is given the No-op sentence, for each of the six', () => {
  assert.deepEqual(Object.keys(OLDER_BUILD_SENTENCES).sort(), [...PLACEHOLDER_JOB_TYPES].sort())
  for (const type of PLACEHOLDER_JOB_TYPES) {
    assert.deepEqual(
      honestPlaceholderText({ type, status: 'completed', result: OLDER_BUILD_SENTENCES[type] }),
      { result: placeholderJobResult(type) },
      type,
    )
  }
})

test('a completed placeholder with no result at all says what it did, and one that already says No-op is left alone', () => {
  for (const type of PLACEHOLDER_JOB_TYPES) {
    assert.deepEqual(honestPlaceholderText({ type, status: 'completed' }), { result: placeholderJobResult(type) }, `${type} with no result`)
    assert.deepEqual(honestPlaceholderText({ type, status: 'completed', result: '' }), { result: placeholderJobResult(type) }, `${type} with an empty result`)
    assert.equal(honestPlaceholderText({ type, status: 'completed', result: placeholderJobResult(type) }), null, `${type} already honest`)
    assert.equal(honestPlaceholderText({ type, status: 'completed', result: `${NO_OP_PREFIX} something a later build said` }), null, `${type}: the prefix is the test`)
  }
})

test('a job that is not a completed placeholder is never touched: queued, running, a real job, a failure that was true', () => {
  for (const status of ['queued', 'processing'] as const) {
    assert.equal(honestPlaceholderText({ type: 'align-scan', status, result: 'requeued after restart' }), null, status)
  }
  for (const type of worldJobTypes().filter((t) => !isPlaceholderJobType(t))) {
    assert.equal(honestPlaceholderText({ type, status: 'completed', result: 'Real work was done.' }), null, `${type}: a job with a worker keeps its own result`)
    assert.equal(honestPlaceholderText({ type, status: 'completed' }), null, `${type}: even with none`)
  }
  for (const failure of ['depth-reconstruct requires RGB keyframe observations. Start keyframe streaming before export.', 'extract-layers requires a selected scan.']) {
    assert.equal(honestPlaceholderText({ type: 'extract-layers', status: 'failed', result: failure, error: failure }), null, failure)
  }
})

test("an align-scan that failed in an older build loses the 'manual control-point target' it offered, in the result and in the error", () => {
  const legacy = 'align-scan needs at least two scans in the world or a manual control-point target.'
  assert.equal(ALIGN_SCAN_NEEDS_TWO_SCANS, 'align-scan needs at least two scans in the world.')
  assert.deepEqual(
    honestPlaceholderText({ type: 'align-scan', status: 'failed', result: legacy, error: legacy }),
    { result: ALIGN_SCAN_NEEDS_TWO_SCANS, error: ALIGN_SCAN_NEEDS_TWO_SCANS },
  )
  assert.deepEqual(honestPlaceholderText({ type: 'align-scan', status: 'failed', error: legacy }), { error: ALIGN_SCAN_NEEDS_TWO_SCANS }, 'only the field that holds it')
  assert.equal(honestPlaceholderText({ type: 'align-scan', status: 'failed', result: ALIGN_SCAN_NEEDS_TWO_SCANS, error: ALIGN_SCAN_NEEDS_TWO_SCANS }), null, 'the current text is already honest')
  assert.equal(honestPlaceholderText({ type: 'semantic-pass', status: 'failed', result: legacy, error: legacy }), null, 'another type that happens to hold the sentence is not align-scan')
})

test('healing a stored world corrects the jobs that hold a claim, in place, says whether it changed any, and finds nothing left the second time', () => {
  const at = '2026-10-01T09:00:00.000Z'
  const stored = (type: WorldJobType, status: WorldJobStatus, extra: Partial<WorldJob> = {}): WorldJob =>
    ({ jobId: `job-${type}-${status}`, worldId: 'w', type, status, capabilities: [], progress: 1, createdAt: at, updatedAt: at, ...extra })
  const jobs: WorldJob[] = [
    ...PLACEHOLDER_JOB_TYPES.map((type) => stored(type, 'completed', { result: OLDER_BUILD_SENTENCES[type] })),
    stored('splat-train', 'completed', { result: 'Gaussian splat trained.' }),
    stored('align-scan', 'queued'),
    stored('depth-reconstruct', 'failed', { error: 'depth-reconstruct requires a selected scan.', result: 'depth-reconstruct requires a selected scan.' }),
  ]
  const before = JSON.stringify(jobs.slice(6))
  assert.equal(healPlaceholderJobs(jobs), true)
  for (const type of PLACEHOLDER_JOB_TYPES) {
    assert.equal(jobs.find((job) => job.type === type && job.status === 'completed')!.result, placeholderJobResult(type), type)
  }
  assert.equal(JSON.stringify(jobs.slice(6)), before, 'a real job, a queued one and a true failure are not touched')
  assert.ok(jobs.every((job) => job.updatedAt === at && job.createdAt === at), 'the times are facts about the run and stay')
  assert.equal(healPlaceholderJobs(jobs), false, 'nothing left to correct the second time')
  assert.equal(healPlaceholderJobs([]), false)
})

test('the job list says the honest sentence for a stored job, whichever field holds the text', () => {
  const legacy = 'align-scan needs at least two scans in the world or a manual control-point target.'
  for (const type of PLACEHOLDER_JOB_TYPES) {
    assert.equal(jobOutcomeText({ type, status: 'completed', result: OLDER_BUILD_SENTENCES[type] }), placeholderJobResult(type), type)
  }
  assert.equal(jobOutcomeText({ type: 'align-scan', status: 'failed', result: legacy, error: legacy }), ALIGN_SCAN_NEEDS_TWO_SCANS)
  assert.equal(jobOutcomeText({ type: 'align-scan', status: 'failed', error: legacy }), ALIGN_SCAN_NEEDS_TWO_SCANS, 'the error, when there is no result')
  assert.equal(jobOutcomeText({ type: 'splat-train', status: 'completed', result: '  Gaussian splat trained.  ' }), 'Gaussian splat trained.', 'a real job keeps its words, trimmed')
  assert.equal(jobOutcomeText({ type: 'splat-train', status: 'failed', error: 'Brush is not installed.' }), 'Brush is not installed.')
  assert.equal(jobOutcomeText({ type: 'splat-train', status: 'queued' }), '')
  const html = jobRowMarkup({ type: 'align-scan', status: 'completed', result: OLDER_BUILD_SENTENCES['align-scan'] }, null, '10:00', mark)
  assert.doesNotMatch(html, /Alignment recorded|Open3D|can refine/, 'the row of a job an older build completed does not repeat its claim')
  assert.match(html, /«No-op: no alignment was computed/)
})

test('source shape: the server corrects what older builds stored when it reads a world, and says no manual control-point target', () => {
  const main = code(read('server/main.ts'))
  const refresh = functionSource(main, 'async function refreshWorldScans(')
  assert.match(refresh, /if \(healPlaceholderJobs\(world\.jobs \?\? \[\]\)\) changed = true/, 'what it corrects is written back: the world is marked changed')
  assert.ok(refresh.indexOf('healPlaceholderJobs(') > refresh.indexOf('world.scans = world.scans.map('), 'after the scans, in the same read that writes the file when something changed')
  assert.ok(refresh.indexOf('healPlaceholderJobs(') < refresh.indexOf('await writeWorldUnlocked(world)'), 'before the file is written')
  assert.match(main, /import \{ ALIGN_SCAN_NEEDS_TWO_SCANS, healPlaceholderJobs, placeholderJobResult \} from '\.\.\/src\/shared\/placeholder-jobs\.ts'/)
  assert.match(functionSource(main, 'function jobFailureReason('), /return ALIGN_SCAN_NEEDS_TWO_SCANS/)
})

test("the quality panel stays silent about a job that does nothing, and keeps naming the ones that work", () => {
  for (const type of PLACEHOLDER_JOB_TYPES) assert.equal(jobProcessingLabel(type), null, `${type} would read as work in progress`)
  assert.equal(jobProcessingLabel('splat-train'), 'training splat')
  assert.equal(jobProcessingLabel('splat-detect'), 'detecting objects')
  assert.equal(jobProcessingLabel('lingbot-map-reconstruct'), 'reconstructing')
  assert.equal(jobProcessingLabel('person-4d-reconstruct'), 'reconstructing person')
  assert.equal(jobProcessingLabel('export-world'), null, 'unchanged: a type with no user-facing meaning')
})

// ── The rest of what presented align-scan as an outcome ──────────────────────────────────────

test("source shape: nothing in the server or the editor still offers 'a manual control-point target', which no input implements", () => {
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const path = `${dir}/${name}`
      if (statSync(join(ROOT, path)).isDirectory()) walk(path)
      else if (/\.ts$/.test(name) && /control-point target/.test(code(read(path)).replace(/LEGACY_ALIGN_SCAN_FAILURE = '[^']*'/, ''))) offenders.push(path)
    }
  }
  walk('server')
  walk('src')
  assert.deepEqual(offenders, [], 'the phrase survives only in the one constant that recognises the older text')
})

test('source shape: the align-scan report artifact is labelled a placeholder', () => {
  const artifacts = functionSource(read('server/main.ts'), 'function jobArtifactsFor(')
  assert.match(artifacts, /label: `\$\{scan\.name\} alignment placeholder`/)
  assert.doesNotMatch(artifacts, /alignment report/)
})
