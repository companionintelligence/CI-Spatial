/**
 * Deno unit tests for the splat-finish driver surface. The real
 * @playcanvas/splat-transform CLI runs fine on CPU, but these tests — like
 * splat_train.test.ts / splat_detect.test.ts — cover only the TS side through
 * the `_spawn` seam: validation gates, CLI arg assembly, the skip/error
 * manifest contract, and output size accounting. The real CLI is exercised by
 * the box-side smoke (docs/pipelines/splat-toolbox.md — Finish).
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'

import {
  buildCompressedArgs,
  buildSogArgs,
  resolveParams,
  runSplatFinish,
} from '../../../server/splat/splat_finish.ts'

/** Minimal INRIA-style PLY header (42 gaussians) for the input fixture. */
const INPUT_PLY = new TextEncoder().encode(
  'ply\nformat binary_little_endian 1.0\nelement vertex 42\nproperty float x\nend_header\n' +
    'BODYBYTES-PADDING-SO-SIZES-DIFFER-FROM-OUTPUTS',
)

async function makeInput(tmp: string): Promise<string> {
  const path = `${tmp}/scan.splat.ply`
  await Deno.writeFile(path, INPUT_PLY)
  return path
}

Deno.test('resolveParams honours explicit overrides over env defaults', () => {
  const p = resolveParams({
    splatPlyPath: '/x/a.splat.ply',
    outputSogPath: '/x/a.sog',
    outputCompressedPlyPath: '/x/a.compressed.ply',
    nodeBin: '/opt/node',
    cliPath: '/opt/cli.mjs',
    gpu: '1',
    iterations: 4,
  })
  assertEquals(p.nodeBin, '/opt/node')
  assertEquals(p.cliPath, '/opt/cli.mjs')
  assertEquals(p.gpu, '1')
  assertEquals(p.iterations, 4)
})

Deno.test('buildSogArgs / buildCompressedArgs assemble the CLI in a stable order', () => {
  const params = resolveParams({
    splatPlyPath: '/x/a.splat.ply',
    outputSogPath: '/x/a.sog',
    outputCompressedPlyPath: '/x/a.compressed.ply',
    cliPath: '/repo/node_modules/@playcanvas/splat-transform/bin/cli.mjs',
    gpu: 'cpu',
    iterations: 10,
  })
  assertEquals(buildSogArgs(params.cliPath, '/x/a.splat.ply', '/x/a.sog', params), [
    '/repo/node_modules/@playcanvas/splat-transform/bin/cli.mjs',
    '-w',
    '-g', 'cpu',
    '-i', '10',
    '/x/a.splat.ply',
    '/x/a.sog',
  ])
  assertEquals(buildCompressedArgs(params.cliPath, '/x/a.splat.ply', '/x/a.compressed.ply'), [
    '/repo/node_modules/@playcanvas/splat-transform/bin/cli.mjs',
    '-w',
    '/x/a.splat.ply',
    '/x/a.compressed.ply',
  ])
})

Deno.test('runSplatFinish skips when the scan has no trained splat', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-finish-test-' })
  const result = await runSplatFinish({
    splatPlyPath: `${tmp}/missing.splat.ply`,
    outputSogPath: `${tmp}/missing.sog`,
    outputCompressedPlyPath: `${tmp}/missing.compressed.ply`,
    _spawn: () => {
      throw new Error('spawn must not be reached when the input is missing')
    },
  })
  assertEquals(result.status, 'skipped')
  assertEquals(result.exitCode, 0)
  assert(result.manifest.skippedReason?.includes('no trained splat'))
  assertStringIncludes(result.manifest.remediation ?? '', 'splat-train')
  // The skip manifest must be written next to the would-be .sog.
  const written = JSON.parse(await Deno.readTextFile(`${tmp}/missing.splat-finish.manifest.json`))
  assertEquals(written.status, 'skipped')
  assertEquals(written.tool, 'splat-transform')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatFinish skips when the splat-transform CLI is missing', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-finish-test-' })
  const input = await makeInput(tmp)
  const result = await runSplatFinish({
    splatPlyPath: input,
    outputSogPath: `${tmp}/scan.sog`,
    outputCompressedPlyPath: `${tmp}/scan.compressed.ply`,
    cliPath: '/this/cli/definitely/does/not/exist.mjs',
    _spawn: () => {
      throw new Error('spawn must not be reached when the CLI is missing')
    },
  })
  assertEquals(result.status, 'skipped')
  assertEquals(result.exitCode, 0)
  assert(result.manifest.skippedReason?.includes('splat-transform CLI not found'))
  assertStringIncludes(result.manifest.remediation ?? '', 'npm install')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatFinish lands both outputs + writes an ok manifest with size accounting', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-finish-test-' })
  const input = await makeInput(tmp)
  const sogBytes = new Uint8Array(350) // pretend-compressed sizes, distinct from input
  const compressedBytes = new Uint8Array(740)
  const spawns: string[][] = []

  const result = await runSplatFinish({
    splatPlyPath: input,
    outputSogPath: `${tmp}/scan.sog`,
    outputCompressedPlyPath: `${tmp}/scan.compressed.ply`,
    cliPath: Deno.execPath(), // exists so the guard passes; _spawn fakes the run
    provenance: { sessionId: 'sess-test-finish', scanId: 'scan-9' },
    _spawn: async (_bin, args) => {
      spawns.push(args)
      const out = args[args.length - 1]
      if (out.endsWith('.sog')) await Deno.writeFile(out, sogBytes)
      else await Deno.writeFile(out, compressedBytes)
      return { code: 0, stderr: '' }
    },
  })

  assertEquals(result.status, 'ok')
  assertEquals(result.exitCode, 0)
  assertEquals(spawns.length, 2)
  assertEquals(result.sogPath, `${tmp}/scan.sog`)
  assertEquals(result.compressedPlyPath, `${tmp}/scan.compressed.ply`)
  // Size accounting must reflect the actual bytes on disk.
  assertEquals(result.sizes?.inputBytes, INPUT_PLY.byteLength)
  assertEquals(result.sizes?.sogBytes, 350)
  assertEquals(result.sizes?.compressedBytes, 740)

  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-finish.manifest.json`))
  assertEquals(manifest.status, 'ok')
  assertEquals(manifest.sogPath, 'scan.sog')
  assertEquals(manifest.compressedPlyPath, 'scan.compressed.ply')
  assertEquals(manifest.sizes, { inputBytes: INPUT_PLY.byteLength, sogBytes: 350, compressedBytes: 740 })
  assertEquals(manifest.gaussianCount, 42) // parsed from the input PLY header
  assertEquals(manifest.sessionId, 'sess-test-finish')
  assertEquals(manifest.scanId, 'scan-9')
  assert(typeof manifest.timing?.elapsedMs === 'number')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatFinish surfaces a CLI failure as an error manifest with the stderr tail', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-finish-test-' })
  const input = await makeInput(tmp)
  const result = await runSplatFinish({
    splatPlyPath: input,
    outputSogPath: `${tmp}/scan.sog`,
    outputCompressedPlyPath: `${tmp}/scan.compressed.ply`,
    cliPath: Deno.execPath(),
    _spawn: async () => ({ code: 1, stderr: 'Error: ENOSPC no space left on device' }),
  })
  assertEquals(result.status, 'error')
  assertEquals(result.exitCode, 1)
  assertStringIncludes(result.log, 'ENOSPC')
  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-finish.manifest.json`))
  assertEquals(manifest.status, 'error')
  assertStringIncludes(manifest.error, 'splat-transform (sog) exited 1')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatFinish errors when the second (compressed.ply) leg fails', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-finish-test-' })
  const input = await makeInput(tmp)
  const result = await runSplatFinish({
    splatPlyPath: input,
    outputSogPath: `${tmp}/scan.sog`,
    outputCompressedPlyPath: `${tmp}/scan.compressed.ply`,
    cliPath: Deno.execPath(),
    _spawn: async (_bin, args) => {
      const out = args[args.length - 1]
      if (out.endsWith('.sog')) {
        await Deno.writeFile(out, new Uint8Array(8))
        return { code: 0, stderr: '' }
      }
      return { code: 2, stderr: 'compressed leg boom' }
    },
  })
  assertEquals(result.status, 'error')
  assertEquals(result.exitCode, 2)
  assertStringIncludes(result.manifest.error ?? '', 'compressed.ply) exited 2')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatFinish errors when the CLI exits 0 but produced no output', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-finish-test-' })
  const input = await makeInput(tmp)
  const result = await runSplatFinish({
    splatPlyPath: input,
    outputSogPath: `${tmp}/scan.sog`,
    outputCompressedPlyPath: `${tmp}/scan.compressed.ply`,
    cliPath: Deno.execPath(),
    _spawn: async () => ({ code: 0, stderr: '' }), // lies: writes nothing
  })
  assertEquals(result.status, 'error')
  assertStringIncludes(result.manifest.error ?? '', 'produced no output')
  await Deno.remove(tmp, { recursive: true })
})
