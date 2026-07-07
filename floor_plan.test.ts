/**
 * Deno unit tests for the floor-plan driver surface, mirroring
 * splat_detect.test.ts: validation gates, worker CLI arg assembly, and the
 * skip/error manifest contract through the `_spawn` seam — plus one REAL
 * worker run on a synthetic box room (four walls + floor + ceiling written as
 * a LingBot-layout binary PLY from TS) asserting the extracted geometry is
 * within tolerance of ground truth. The real run is skipped when the numpy
 * venv is not present on the box.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'

import {
  buildFloorPlanArgs,
  isValidSessionDir,
  resolveParams,
  runFloorPlan,
  summarizePlan,
} from './floor_plan.ts'

const REAL_PYTHON = Deno.env.get('FLOORPLAN_PYTHON')
  ?? `${Deno.env.get('HOME')}/.venvs/lingbot-map/bin/python`
const HAS_REAL_PYTHON = (() => {
  try {
    return Deno.statSync(REAL_PYTHON).isFile
  } catch {
    return false
  }
})()

// ── Synthetic box-room PLY (numpy-free TS generation) ─────────────────────────

/** Deterministic PRNG so the fixture (and the seeded worker) never flakes. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ROOM_W = 4.0 // truth: 4m x 3m room, 2.5m ceiling → 12 m²
const ROOM_D = 3.0
const ROOM_H = 2.5

/**
 * Write a ~50k-point box room in the exact LingBot-Map PLY layout
 * (binary-LE, float32 x/y/z + uchar r/g/b): dense floor + ceiling planes and
 * four vertical walls with a little sensor-ish jitter.
 */
async function writeBoxRoomPly(path: string): Promise<number> {
  const rand = mulberry32(1234)
  const gauss = (sigma: number) => {
    // Box-Muller; clamp the log arg away from 0.
    const u = Math.max(rand(), 1e-12)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()) * sigma
  }
  const pts: number[] = []
  const push = (x: number, y: number, z: number) => { pts.push(x, y, z) }
  const N_PLANE = 12000
  const N_WALL = 6500
  for (const z of [0, ROOM_H]) {
    for (let i = 0; i < N_PLANE; i++) push(rand() * ROOM_W, rand() * ROOM_D, z + gauss(0.005))
  }
  for (const x of [0, ROOM_W]) {
    for (let i = 0; i < N_WALL; i++) push(x + gauss(0.008), rand() * ROOM_D, rand() * ROOM_H)
  }
  for (const y of [0, ROOM_D]) {
    for (let i = 0; i < N_WALL; i++) push(rand() * ROOM_W, y + gauss(0.008), rand() * ROOM_H)
  }
  const count = pts.length / 3
  const header = 'ply\nformat binary_little_endian 1.0\n' +
    `element vertex ${count}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property uchar red\nproperty uchar green\nproperty uchar blue\n' +
    'end_header\n'
  const headerBytes = new TextEncoder().encode(header)
  const body = new Uint8Array(count * 15)
  const view = new DataView(body.buffer)
  for (let i = 0; i < count; i++) {
    const off = i * 15
    view.setFloat32(off, pts[i * 3], true)
    view.setFloat32(off + 4, pts[i * 3 + 1], true)
    view.setFloat32(off + 8, pts[i * 3 + 2], true)
    body[off + 12] = 128
    body[off + 13] = 128
    body[off + 14] = 128
  }
  const out = new Uint8Array(headerBytes.length + body.length)
  out.set(headerBytes, 0)
  out.set(body, headerBytes.length)
  await Deno.writeFile(path, out)
  return count
}

/** Session dir holding a synthetic lingbot-map.point-cloud.ply. */
async function makeSession(tmp: string, ply?: Uint8Array): Promise<string> {
  const dir = `${tmp}/sess-floorplan-test`
  await Deno.mkdir(dir, { recursive: true })
  if (ply) await Deno.writeFile(`${dir}/lingbot-map.point-cloud.ply`, ply)
  return dir
}

const TINY_PLY = new TextEncoder().encode(
  'ply\nformat binary_little_endian 1.0\nelement vertex 0\n' +
    'property float x\nproperty float y\nproperty float z\nend_header\n',
)

// ── Params + arg assembly ─────────────────────────────────────────────────────

Deno.test('resolveParams honours explicit overrides over env defaults', () => {
  const p = resolveParams({
    outputJsonPath: '/x/a.floor-plan.json',
    outputSvgPath: '/x/a.floor-plan.svg',
    python: '/opt/py',
    workerPath: '/opt/worker.py',
    minWallM: '0.8',
  })
  assertEquals(p.python, '/opt/py')
  assertEquals(p.workerPath, '/opt/worker.py')
  assertEquals(p.minWallM, '0.8')
})

Deno.test('buildFloorPlanArgs assembles the worker CLI in a stable order', () => {
  const params = resolveParams({
    outputJsonPath: '/x/a.floor-plan.json',
    outputSvgPath: '/x/a.floor-plan.svg',
    workerPath: '/repo/scripts/floor_plan_worker.py',
    minWallM: '0.5',
  })
  assertEquals(
    buildFloorPlanArgs(params.workerPath, '/sess/lingbot-map.point-cloud.ply', '/job/plan.json', '/job/plan.svg', params),
    [
      '/repo/scripts/floor_plan_worker.py',
      '--ply', '/sess/lingbot-map.point-cloud.ply',
      '--out-json', '/job/plan.json',
      '--out-svg', '/job/plan.svg',
      '--min-wall-m', '0.5',
    ],
  )
})

Deno.test('isValidSessionDir accepts sess-* basenames only', () => {
  assert(isValidSessionDir('/data/sessions/sess-abc-123'))
  assert(!isValidSessionDir('/data/sessions/../../etc'))
  assert(!isValidSessionDir('/data/sessions/whatever'))
})

Deno.test('summarizePlan pulls headline numbers and rejects junk', () => {
  const s = summarizePlan(JSON.stringify({
    areaM2: 11.9,
    ceilingHeightM: 2.5,
    walls: [{}, {}, {}, {}],
    rooms: [{ polygon: [], areaM2: 11.9 }],
  }))
  assertEquals(s, { areaM2: 11.9, wallCount: 4, roomCount: 1, ceilingHeightM: 2.5 })
  assertEquals(summarizePlan('not json'), null)
  assertEquals(summarizePlan('{"walls": 3}'), null)
})

// ── Skip gates (spawn must never be reached) ──────────────────────────────────

Deno.test('runFloorPlan skips when the python interpreter is missing', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'floor-plan-test-' })
  const session = await makeSession(tmp, TINY_PLY)
  const result = await runFloorPlan({
    sessionDir: session,
    outputJsonPath: `${tmp}/scan.floor-plan.json`,
    outputSvgPath: `${tmp}/scan.floor-plan.svg`,
    python: '/this/python/does/not/exist',
    _spawn: () => {
      throw new Error('spawn must not be reached when python is missing')
    },
  })
  assertEquals(result.status, 'skipped')
  assertEquals(result.exitCode, 0)
  assert(result.manifest.skippedReason?.includes('python not found'))
  assertStringIncludes(result.manifest.remediation ?? '', 'FLOORPLAN_PYTHON')
  const written = JSON.parse(await Deno.readTextFile(`${tmp}/scan.floor-plan.manifest.json`))
  assertEquals(written.status, 'skipped')
  assertEquals(written.tool, 'floor-plan-worker')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runFloorPlan skips when the session has no point cloud', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'floor-plan-test-' })
  const session = await makeSession(tmp) // no ply inside
  const result = await runFloorPlan({
    sessionDir: session,
    outputJsonPath: `${tmp}/scan.floor-plan.json`,
    outputSvgPath: `${tmp}/scan.floor-plan.svg`,
    python: '/bin/true',
    workerPath: '/bin/true',
    _spawn: () => {
      throw new Error('spawn must not be reached without an input cloud')
    },
  })
  assertEquals(result.status, 'skipped')
  assert(result.manifest.skippedReason?.includes('no point cloud'))
  assertStringIncludes(result.manifest.remediation ?? '', 'lingbot-map-reconstruct')
  await Deno.remove(tmp, { recursive: true })
})

// ── _spawn-seam ok / error paths ──────────────────────────────────────────────

Deno.test('runFloorPlan lands plan JSON + SVG and writes an ok manifest', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'floor-plan-test-' })
  const session = await makeSession(tmp, TINY_PLY)
  const spawns: string[][] = []
  const plan = {
    areaM2: 12.0,
    ceilingHeightM: 2.5,
    walls: [{}, {}, {}, {}],
    rooms: [{ polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], areaM2: 12.0 }],
  }

  const result = await runFloorPlan({
    sessionDir: session,
    outputJsonPath: `${tmp}/scan.floor-plan.json`,
    outputSvgPath: `${tmp}/scan.floor-plan.svg`,
    python: '/bin/true',
    workerPath: '/bin/true',
    minWallM: '0.7',
    provenance: { sessionId: 'sess-floorplan-test', scanId: 'scan-3' },
    _spawn: async (_bin, args) => {
      spawns.push(args)
      const outJson = args[args.indexOf('--out-json') + 1]
      const outSvg = args[args.indexOf('--out-svg') + 1]
      await Deno.writeTextFile(outJson, JSON.stringify(plan))
      await Deno.writeTextFile(outSvg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
      return { code: 0, stderr: '' }
    },
  })

  assertEquals(result.status, 'ok')
  assertEquals(result.exitCode, 0)
  assertEquals(spawns.length, 1)
  // Worker must have been pointed at the session's cloud with the tuned knob.
  assertEquals(spawns[0][spawns[0].indexOf('--ply') + 1], `${session}/lingbot-map.point-cloud.ply`)
  assertEquals(spawns[0][spawns[0].indexOf('--min-wall-m') + 1], '0.7')
  assertEquals(result.areaM2, 12.0)
  assertEquals(result.wallCount, 4)
  assertEquals(await Deno.readTextFile(`${tmp}/scan.floor-plan.json`), JSON.stringify(plan))
  assertStringIncludes(await Deno.readTextFile(`${tmp}/scan.floor-plan.svg`), '<svg')

  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.floor-plan.manifest.json`))
  assertEquals(manifest.status, 'ok')
  assertEquals(manifest.planPath, 'scan.floor-plan.json')
  assertEquals(manifest.svgPath, 'scan.floor-plan.svg')
  assertEquals(manifest.areaM2, 12.0)
  assertEquals(manifest.wallCount, 4)
  assertEquals(manifest.roomCount, 1)
  assertEquals(manifest.ceilingHeightM, 2.5)
  assertEquals(manifest.sessionId, 'sess-floorplan-test')
  assertEquals(manifest.scanId, 'scan-3')
  assert(typeof manifest.timing?.elapsedMs === 'number')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runFloorPlan surfaces a worker crash as an error manifest with the stderr tail', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'floor-plan-test-' })
  const session = await makeSession(tmp, TINY_PLY)
  const result = await runFloorPlan({
    sessionDir: session,
    outputJsonPath: `${tmp}/scan.floor-plan.json`,
    outputSvgPath: `${tmp}/scan.floor-plan.svg`,
    python: '/bin/true',
    workerPath: '/bin/true',
    _spawn: async () => ({ code: 2, stderr: 'floor-plan: too few points (3)' }),
  })
  assertEquals(result.status, 'error')
  assertEquals(result.exitCode, 2)
  assertStringIncludes(result.log, 'too few points')
  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.floor-plan.manifest.json`))
  assertEquals(manifest.status, 'error')
  assertStringIncludes(manifest.error, 'exited 2')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runFloorPlan errors when the worker exits 0 but produced no plan', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'floor-plan-test-' })
  const session = await makeSession(tmp, TINY_PLY)
  const result = await runFloorPlan({
    sessionDir: session,
    outputJsonPath: `${tmp}/scan.floor-plan.json`,
    outputSvgPath: `${tmp}/scan.floor-plan.svg`,
    python: '/bin/true',
    workerPath: '/bin/true',
    _spawn: async () => ({ code: 0, stderr: '' }), // lies: writes nothing
  })
  assertEquals(result.status, 'error')
  assertStringIncludes(result.manifest.error ?? '', 'produced no plan')
  await Deno.remove(tmp, { recursive: true })
})

// ── REAL worker: synthetic box room → geometry within tolerance ──────────────

Deno.test({
  name: 'runFloorPlan + real worker extract a 4m x 3m box room within 10% of truth',
  ignore: !HAS_REAL_PYTHON,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: 'floor-plan-real-test-' })
    const session = `${tmp}/sess-box-room`
    await Deno.mkdir(session, { recursive: true })
    const count = await writeBoxRoomPly(`${session}/lingbot-map.point-cloud.ply`)
    assert(count >= 49000, `fixture should be ~50k points, got ${count}`)

    const result = await runFloorPlan({
      sessionDir: session,
      outputJsonPath: `${tmp}/room.floor-plan.json`,
      outputSvgPath: `${tmp}/room.floor-plan.svg`,
      python: REAL_PYTHON,
      provenance: { sessionId: 'sess-box-room', scanId: 'scan-room' },
    })
    assertEquals(result.status, 'ok', `worker failed: ${result.manifest.error ?? result.log}`)

    const plan = JSON.parse(await Deno.readTextFile(`${tmp}/room.floor-plan.json`))
    // Four dominant walls (RANSAC may split a wall across gaps → allow +2).
    assert(plan.wallCount >= 4 && plan.wallCount <= 6, `expected ~4 walls, got ${plan.wallCount}`)
    // Area within 10% of the 12 m² ground truth.
    const truth = ROOM_W * ROOM_D
    assert(
      Math.abs(plan.areaM2 - truth) <= truth * 0.1,
      `areaM2 ${plan.areaM2} not within 10% of ${truth}`,
    )
    // Ceiling height within 10cm of the 2.5m truth.
    assert(Math.abs(plan.ceilingHeightM - ROOM_H) <= 0.1, `ceilingHeightM ${plan.ceilingHeightM}`)
    assertEquals(plan.disclaimer, 'derived, not survey-grade')
    assert(Array.isArray(plan.rooms) && plan.rooms.length >= 1, 'expected a closed room polygon')

    // The SVG must be a valid standalone document with walls + dimension labels.
    const svg = await Deno.readTextFile(`${tmp}/room.floor-plan.svg`)
    assertStringIncludes(svg, '<svg xmlns="http://www.w3.org/2000/svg"')
    assertStringIncludes(svg, '</svg>')
    assertStringIncludes(svg, ' m</text>') // dimension label
    assertStringIncludes(svg, 'derived, not survey-grade')

    const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/room.floor-plan.manifest.json`))
    assertEquals(manifest.status, 'ok')
    assertEquals(manifest.wallCount, plan.wallCount)
    assertEquals(manifest.areaM2, plan.areaM2)
    await Deno.remove(tmp, { recursive: true })
  },
})
