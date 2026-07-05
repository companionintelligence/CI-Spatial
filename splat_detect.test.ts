/**
 * Deno unit tests for the splat-detect driver surface. The real splat_analyzer
 * pipeline is a ROCm/torch GPU job that can't run in CI, so — like
 * splat_train.test.ts — these cover only the TS side: CLI arg assembly,
 * interactions.json object counting, the "python/dir missing → skipped
 * manifest" fallback, and the ok/error contracts via an injected spawn seam.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'

import {
  buildDetectArgs,
  countInteractions,
  isValidSessionDir,
  resolveParams,
  runSplatDetect,
} from './splat_detect.ts'

Deno.test('isValidSessionDir accepts canonical session ids, rejects traversal', () => {
  assert(isValidSessionDir('/tmp/scans/sessions/sess-12345-abcde'))
  assert(isValidSessionDir('./scans/sessions/session-19710101-test'))
  assert(!isValidSessionDir('/etc/passwd'))
  assert(!isValidSessionDir('../../etc'))
})

Deno.test('resolveParams honours explicit overrides over env defaults', () => {
  const p = resolveParams({
    outputInteractionsPath: '/x/a.interactions.json',
    python: '/opt/py',
    detectDir: '/opt/splat_analyzer',
    prompt: 'chair, sofa',
    hipVisibleDevices: '0',
    pointSplatSize: '9',
  })
  assertEquals(p.python, '/opt/py')
  assertEquals(p.detectDir, '/opt/splat_analyzer')
  assertEquals(p.prompt, 'chair, sofa')
  assertEquals(p.hipVisibleDevices, '0')
  assertEquals(p.pointSplatSize, '9')
  assertEquals(p.quality, 'medium') // default when neither option nor env sets it
  assertEquals(p.renderer, 'point')
})

Deno.test('buildDetectArgs assembles the run_local.py CLI in a stable order', () => {
  const params = resolveParams({ outputInteractionsPath: '/x/a.interactions.json', prompt: 'chair, table' })
  const args = buildDetectArgs('/opt/sa/run_local.py', '/data/scene.splat.ply', '/tmp/job', params)
  // Default quality is 'medium'; clustering knobs are unset → not passed.
  assertEquals(args, [
    '/opt/sa/run_local.py',
    '--ply', '/data/scene.splat.ply',
    '--prompt', 'chair, table',
    '--quality', 'medium',
    '--renderer', 'point',
    '--job_dir', '/tmp/job',
  ])
})

Deno.test('buildDetectArgs appends clustering knobs only when set', () => {
  const params = resolveParams({
    outputInteractionsPath: '/x/a.interactions.json',
    prompt: 'sofa',
    quality: 'high',
    scoreThreshold: '0.08',
    minVotes: '3',
    minPeakScore: '0.3',
  })
  const args = buildDetectArgs('/opt/sa/run_local.py', '/data/s.ply', '/tmp/j', params)
  assert(args[args.indexOf('--quality') + 1] === 'high')
  assert(args[args.indexOf('--score_threshold') + 1] === '0.08')
  assert(args[args.indexOf('--min_votes') + 1] === '3')
  assert(args[args.indexOf('--min_peak_score') + 1] === '0.3')
})

Deno.test('resolveParams honours env tuning defaults', () => {
  const prev = {
    q: Deno.env.get('SPLAT_DETECT_QUALITY'),
    v: Deno.env.get('SPLAT_DETECT_MIN_VOTES'),
  }
  try {
    Deno.env.set('SPLAT_DETECT_QUALITY', 'low')
    Deno.env.set('SPLAT_DETECT_MIN_VOTES', '2')
    const p = resolveParams({ outputInteractionsPath: '/x/a.json' })
    assertEquals(p.quality, 'low')
    assertEquals(p.minVotes, '2')
    // explicit option still wins over env
    const p2 = resolveParams({ outputInteractionsPath: '/x/a.json', quality: 'high', minVotes: '5' })
    assertEquals(p2.quality, 'high')
    assertEquals(p2.minVotes, '5')
  } finally {
    prev.q == null ? Deno.env.delete('SPLAT_DETECT_QUALITY') : Deno.env.set('SPLAT_DETECT_QUALITY', prev.q)
    prev.v == null ? Deno.env.delete('SPLAT_DETECT_MIN_VOTES') : Deno.env.set('SPLAT_DETECT_MIN_VOTES', prev.v)
  }
})

Deno.test('countInteractions parses array, {objects}, and {interactions} shapes', () => {
  assertEquals(countInteractions('[{"a":1},{"b":2},{"c":3}]'), 3)
  assertEquals(countInteractions('{"objects":[{"label":"chair"},{"label":"table"}]}'), 2)
  assertEquals(countInteractions('{"interactions":[{"x":1}]}'), 1)
  assertEquals(countInteractions('not json'), null)
  assertEquals(countInteractions('{"scene":"x"}'), null)
})

Deno.test('runSplatDetect returns a skipped result when the python venv is missing', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-detect-test-' })
  const result = await runSplatDetect({
    outputInteractionsPath: `${tmp}/scan.interactions.json`,
    python: '/this/python/definitely/does/not/exist',
    detectDir: tmp, // dir exists but python guard fires first
  })
  assertEquals(result.status, 'skipped')
  assertEquals(result.exitCode, 0)
  assert(result.manifest.skippedReason?.includes('python not found'))
  assert(typeof result.manifest.remediation === 'string')
  const written = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-detect.manifest.json`))
  assertEquals(written.status, 'skipped')
  assertEquals(written.tool, 'splat-analyzer')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatDetect skips when run_local.py is absent even if python exists', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-detect-test-' })
  const result = await runSplatDetect({
    outputInteractionsPath: `${tmp}/scan.interactions.json`,
    python: '/bin/true', // exists + executable
    detectDir: `${tmp}/no-such-analyzer`, // run_local.py won't be found
    splatPlyPath: `${tmp}/scan.splat.ply`,
  })
  assertEquals(result.status, 'skipped')
  assertEquals(result.exitCode, 0)
  assert(result.manifest.skippedReason?.includes('run_local.py not found'))
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatDetect skips when there is no input ply (no splat, no cloud)', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-detect-test-' })
  // Analyzer dir with a run_local.py stub so the earlier guards pass.
  const detectDir = `${tmp}/analyzer`
  await Deno.mkdir(detectDir, { recursive: true })
  await Deno.writeTextFile(`${detectDir}/run_local.py`, '# stub')
  const sessionDir = `${tmp}/sess-detect-abcd`
  await Deno.mkdir(sessionDir, { recursive: true }) // no point-cloud.ply inside

  const result = await runSplatDetect({
    outputInteractionsPath: `${tmp}/scan.interactions.json`,
    python: '/bin/true',
    detectDir,
    sessionDir,
    splatPlyPath: `${tmp}/does-not-exist.splat.ply`,
  })
  assertEquals(result.status, 'skipped')
  assertEquals(result.exitCode, 0)
  assert(result.manifest.skippedReason?.includes('no splat'))
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatDetect lands interactions.json + writes an ok manifest via injected spawn', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-detect-test-' })
  const detectDir = `${tmp}/analyzer`
  await Deno.mkdir(detectDir, { recursive: true })
  await Deno.writeTextFile(`${detectDir}/run_local.py`, '# stub')
  const splatPlyPath = `${tmp}/scan.splat.ply`
  await Deno.writeTextFile(splatPlyPath, 'ply\nformat binary_little_endian 1.0\nelement vertex 3\nend_header\n')

  const outputInteractionsPath = `${tmp}/scan.interactions.json`
  const result = await runSplatDetect({
    splatPlyPath,
    outputInteractionsPath,
    python: '/bin/true',
    detectDir,
    prompt: 'chair, table',
    provenance: { sessionId: 'sess-detect-wxyz', scanId: 'scan-1' },
    // Fake the analyzer run: write interactions.json into the job_dir.
    _spawn: async (_bin, args) => {
      const jobDir = args[args.indexOf('--job_dir') + 1]
      await Deno.writeTextFile(
        `${jobDir}/interactions.json`,
        JSON.stringify({ objects: [{ label: 'chair' }, { label: 'table' }] }),
      )
      return { code: 0, stderr: '' }
    },
  })

  assertEquals(result.status, 'ok')
  assertEquals(result.objectCount, 2)
  assertEquals(result.interactionsPath, outputInteractionsPath)
  const landed = JSON.parse(await Deno.readTextFile(outputInteractionsPath))
  assertEquals(landed.objects.length, 2)
  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-detect.manifest.json`))
  assertEquals(manifest.status, 'ok')
  assertEquals(manifest.objectCount, 2)
  assertEquals(manifest.prompt, 'chair, table')
  assertEquals(manifest.scanId, 'scan-1')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatDetect converts a session point cloud when no trained splat exists', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-detect-test-' })
  const detectDir = `${tmp}/analyzer`
  await Deno.mkdir(detectDir, { recursive: true })
  await Deno.writeTextFile(`${detectDir}/run_local.py`, '# stub')
  const sessionDir = `${tmp}/sess-detect-cloud`
  await Deno.mkdir(sessionDir, { recursive: true })
  await Deno.writeTextFile(
    `${sessionDir}/lingbot-map.point-cloud.ply`,
    'ply\nformat binary_little_endian 1.0\nelement vertex 0\nend_header\n',
  )

  let sawConvert = false
  const result = await runSplatDetect({
    sessionDir,
    outputInteractionsPath: `${tmp}/scan.interactions.json`,
    python: '/bin/true',
    detectDir,
    // First spawn = pointcloud_to_gs (writes the converted ply); second = detect.
    _spawn: async (_bin, args) => {
      if (args[0].endsWith('pointcloud_to_gs.py')) {
        sawConvert = true
        await Deno.writeTextFile(args[2], 'ply\nformat binary_little_endian 1.0\nelement vertex 0\nend_header\n')
        return { code: 0, stderr: '' }
      }
      const jobDir = args[args.indexOf('--job_dir') + 1]
      await Deno.writeTextFile(`${jobDir}/interactions.json`, JSON.stringify([{ label: 'sofa' }]))
      return { code: 0, stderr: '' }
    },
  })

  assert(sawConvert, 'expected the driver to convert the point cloud first')
  assertEquals(result.status, 'ok')
  assertEquals(result.objectCount, 1)
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatDetect surfaces an analyzer failure as an error manifest with the stderr tail', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-detect-test-' })
  const detectDir = `${tmp}/analyzer`
  await Deno.mkdir(detectDir, { recursive: true })
  await Deno.writeTextFile(`${detectDir}/run_local.py`, '# stub')
  const splatPlyPath = `${tmp}/scan.splat.ply`
  await Deno.writeTextFile(splatPlyPath, 'ply\n')

  const result = await runSplatDetect({
    splatPlyPath,
    outputInteractionsPath: `${tmp}/scan.interactions.json`,
    python: '/bin/true',
    detectDir,
    _spawn: async () => ({ code: 1, stderr: 'Traceback: RuntimeError: HIP out of memory' }),
  })
  assertEquals(result.status, 'error')
  assertEquals(result.exitCode, 1)
  assertStringIncludes(result.log ?? '', 'HIP out of memory')
  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-detect.manifest.json`))
  assertEquals(manifest.status, 'error')
  assertStringIncludes(manifest.error, 'splat-analyzer exited 1')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatDetect errors when the analyzer produced no interactions.json', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-detect-test-' })
  const detectDir = `${tmp}/analyzer`
  await Deno.mkdir(detectDir, { recursive: true })
  await Deno.writeTextFile(`${detectDir}/run_local.py`, '# stub')
  const splatPlyPath = `${tmp}/scan.splat.ply`
  await Deno.writeTextFile(splatPlyPath, 'ply\n')

  const result = await runSplatDetect({
    splatPlyPath,
    outputInteractionsPath: `${tmp}/scan.interactions.json`,
    python: '/bin/true',
    detectDir,
    _spawn: async () => ({ code: 0, stderr: '' }), // exits clean but writes nothing
  })
  assertEquals(result.status, 'error')
  assertStringIncludes(result.manifest.error ?? '', 'no interactions.json')
  await Deno.remove(tmp, { recursive: true })
})
