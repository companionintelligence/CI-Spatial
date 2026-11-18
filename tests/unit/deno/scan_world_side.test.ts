/**
 * What deleting a scan needs from the worlds (server/scan_world_side.ts), over a stand-in for main.ts's `mutateWorldFiles` and
 * real temporary directories for the exports.
 *
 * What these hold: a job running on the scan in any world refuses the deletion and cancels nothing anywhere; with none
 * running, the jobs waiting for the scan are taken out of each world that holds them and nothing else is; a job that starts
 * between the first look and the second is caught by the second; the finished SenseNova jobs are named; the jobs running on
 * any scan are listed for a wipe; and exports are removed for the exports that hold the scan only (or all of them for a wipe),
 * with a failure thrown, not swallowed. An export holds a scan when its world lists the scan or when the export itself says so
 * (the scan's node names its file and id in the glTF's JSON chunk, as the composer writes it): a world a scan was moved out
 * of, or one that has gone, can still have an export that holds a copy of the scan's geometry.
 */
import { assert, assertEquals, assertFalse, assertRejects } from 'jsr:@std/assert@^1.0.0'
import { Document, Primitive } from '@gltf-transform/core'
import type { ScanManifest, WorldJob, WorldJobStatus, WorldJobType, WorldProject } from '../../../src/world/types.ts'
import { scanIdFor } from '../../../server/scan_id.ts'
import { scanWorldSide } from '../../../server/scan_world_side.ts'
import { composeWorldExport } from '../../../server/world_export.ts'
import { cannotRemoveFromReadOnlyFolder } from './read_only_folders.ts'

/** Root can read and write anywhere, so a test that makes its failure with permissions is ignored there, not passed. */
const CAN_MAKE_A_PERMISSION_FAILURE = await cannotRemoveFromReadOnlyFolder()

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

/**
 * A binary glTF as the composer writes an export (server/world_export.ts): the JSON chunk first, one root node per scan with the
 * scan's file and id in its extras, and a BIN chunk after it that nothing here reads.
 */
function exportOf(filenames: readonly string[]): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: filenames.map((_, index) => index) }],
    nodes: filenames.map((filename) => ({ name: filename, extras: { scanId: scanIdFor(filename), sessionId: null, filename, capturedAt: null } })),
    buffers: [{ byteLength: 8 }],
  }))
  const padded = new Uint8Array(new ArrayBuffer(Math.ceil(json.length / 4) * 4)).fill(0x20)
  padded.set(json)
  const bin = new Uint8Array(8)
  const out = new Uint8Array(new ArrayBuffer(12 + 8 + padded.length + 8 + bin.length))
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, out.length, true)
  view.setUint32(12, padded.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(padded, 20)
  view.setUint32(20 + padded.length, bin.length, true)
  view.setUint32(24 + padded.length, 0x004e4942, true)
  out.set(bin, 28 + padded.length)
  return out
}

async function writeExport(dir: string, slug: string, filenames: readonly string[]): Promise<void> {
  await Deno.writeFile(`${dir}/${slug}.world.glb`, exportOf(filenames))
}

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
    // Exports as the composer writes them: each holds the scans its world listed when it was built.
    await writeExport(dir, 'default', [MINE, OTHER])
    await writeExport(dir, 'project-p', [MINE])
    await writeExport(dir, 'project-q', [OTHER])
    const worlds = [world('default', [MINE, OTHER], []), world('project-p', [MINE], []), world('project-q', [OTHER], [])]
    assertEquals(await side(worlds, dir).dropExportsHolding(MINE), 2)
    assertFalse(await exists(`${dir}/default.world.glb`))
    assertFalse(await exists(`${dir}/project-p.world.glb`))
    assert(await exists(`${dir}/project-q.world.glb`), 'a world that never held the scan keeps its export')
    assertEquals(await side(worlds, dir).dropExportsHolding(MINE), 0, 'a world with no export is not an error')
  })
})

/** A scan document as the optimizer leaves one, small enough to compose: one node with one triangle. */
function triangle(name: string): Document {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const acc = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer)
  const prim = doc.createPrimitive().setMode(Primitive.Mode.TRIANGLES).setAttribute('POSITION', acc)
  doc.createScene(name).addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)))
  return doc
}

/** The export the server builds for a world that lists `filenames`: the real composer, over a small document for each scan. */
async function composedExport(filenames: readonly string[]): Promise<Uint8Array> {
  const scans = filenames.map((filename) => ({
    scanId: scanIdFor(filename),
    sessionId: null,
    filename,
    name: filename,
    capturedAt: null,
    localToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  }) as unknown as ScanManifest)
  const exported = await composeWorldExport(
    { worldId: 'w', name: 'A Place', scans, things: [], thingObservations: [] } as unknown as WorldProject,
    new Map(scans.map((scan) => [scan.scanId, triangle(scan.filename)])),
  )
  assertEquals(exported.missingScans, [], 'every scan is in the export')
  return exported.bytes
}

Deno.test('an export that holds the scan goes whatever world it came from: one whose world no longer lists the scan, and one whose world has gone', async () => {
  await withDir(async (dir) => {
    // The exports the composer builds for Place A (which listed MINE when it was built) and Place C (which never did) ...
    await Deno.writeFile(`${dir}/project-a.world.glb`, await composedExport([MINE, OTHER]))
    await Deno.writeFile(`${dir}/project-c.world.glb`, await composedExport([OTHER]))
    await Deno.writeFile(`${dir}/project-gone.world.glb`, await composedExport([MINE]))
    // ... and the worlds as they are now: the scan was moved out of A into B, C never held it, and the world of `gone` was removed.
    const worlds = [world('project-a', [OTHER], []), world('project-b', [MINE], []), world('project-c', [OTHER], [])]
    assertEquals(await side(worlds, dir).dropExportsHolding(MINE), 2)
    assertFalse(await exists(`${dir}/project-a.world.glb`), 'A\'s world no longer lists the scan, but its export holds a copy of it')
    assertFalse(await exists(`${dir}/project-gone.world.glb`), 'a world that has gone leaves an export that holds it too')
    assert(await exists(`${dir}/project-c.world.glb`), 'an export that does not hold the scan stays')
    assertEquals(await side(worlds, dir).dropExportsHolding(MINE), 0, 'nothing is left to find')
  })
})

Deno.test('an export is judged by the scan it names, to the quote: a scan whose name starts the same, or contains it, is not this one', async () => {
  await withDir(async (dir) => {
    await writeExport(dir, 'project-a', ['100_room2.glb', 'x100_room.glb', '100_room.glb.bak.glb', 'a100_room.glb'])
    assertEquals(await side([], dir).dropExportsHolding(MINE), 0)
    assert(await exists(`${dir}/project-a.world.glb`))
    await writeExport(dir, 'project-b', ['100_room2.glb', MINE])
    assertEquals(await side([], dir).dropExportsHolding(MINE), 1)
    assert(await exists(`${dir}/project-a.world.glb`) && !(await exists(`${dir}/project-b.world.glb`)))
  })
})

/** Every kind of export that cannot be read as a binary glTF whose first chunk is JSON of a size this reads, beside one that can be read and does not hold `MINE`. */
async function writeUnreadableExports(dir: string): Promise<void> {
  await writeExport(dir, 'project-ok', [OTHER])
  await Deno.writeTextFile(`${dir}/project-text.world.glb`, 'not a glTF at all')
  await Deno.writeFile(`${dir}/project-empty.world.glb`, new Uint8Array(0))
  await Deno.writeFile(`${dir}/project-short.world.glb`, exportOf([OTHER]).subarray(0, 14))
  // A glTF whose first chunk is not JSON, and one that says its JSON is larger than any this server builds.
  const notJson = exportOf([OTHER])
  new DataView(notJson.buffer).setUint32(16, 0x004e4942, true)
  await Deno.writeFile(`${dir}/project-notjson.world.glb`, notJson)
  const huge = exportOf([OTHER])
  new DataView(huge.buffer).setUint32(12, 0x7fffffff, true)
  await Deno.writeFile(`${dir}/project-huge.world.glb`, huge)
  // Cut short in the middle of its JSON chunk.
  await Deno.writeFile(`${dir}/project-cut.world.glb`, exportOf([OTHER]).subarray(0, 60))
}

const namesIn = async (dir: string): Promise<string[]> => (await Array.fromAsync(Deno.readDir(dir))).map((entry) => entry.name).sort()

Deno.test('an export that cannot be read as a binary glTF cannot be shown not to hold the scan, so it goes with a scan that was found, and one that can be read and does not hold it stays', async () => {
  await withDir(async (dir) => {
    await writeUnreadableExports(dir)
    assertEquals(await side([], dir).dropExportsHolding(MINE, { scanFound: true }), 6)
    assertEquals(await namesIn(dir), ['project-ok.world.glb'])
  })
})

Deno.test('a scan nothing was found of takes no export with it: one that cannot be read is no evidence that the scan was there, and nothing is removed or counted', async () => {
  await withDir(async (dir) => {
    await writeUnreadableExports(dir)
    const before = await namesIn(dir)
    assertEquals(before.length, 7)
    // Nothing of the scan: no files of its own, no world that lists it (one lists another scan), no export that names it.
    const worlds = [world('project-p', [OTHER], [])]
    for (const options of [undefined, {}, { scanFound: false }]) {
      assertEquals(await side(worlds, dir).dropExportsHolding(MINE, options), 0, JSON.stringify(options))
      assertEquals(await namesIn(dir), before, `${JSON.stringify(options)}: every export is still there`)
    }
  })
})

Deno.test('an export that cannot be read goes when the scan was found by something other than the deletion\'s own files: a world that lists it, or an export that names it', async () => {
  // Found by a world: it lists the scan, whether or not it has an export of its own.
  await withDir(async (dir) => {
    await writeUnreadableExports(dir)
    assertEquals(await side([world('project-q', [MINE], [])], dir).dropExportsHolding(MINE, { scanFound: false }), 6, 'the six that cannot be read; the world has no export of its own')
    assertEquals(await namesIn(dir), ['project-ok.world.glb'])
  })
  // Found by an export: another world's export names the scan, and the ones that cannot be read go with it.
  await withDir(async (dir) => {
    await writeUnreadableExports(dir)
    await writeExport(dir, 'project-gone', [MINE, OTHER])
    assertEquals(await side([], dir).dropExportsHolding(MINE, { scanFound: false }), 7, 'the export that names it, and the six that cannot be read')
    assertEquals(await namesIn(dir), ['project-ok.world.glb'])
  })
})

Deno.test('only the exports are looked at: a folder, a link and a world file that are in the worlds folder are not read or removed', async () => {
  await withDir(async (dir) => {
    await Deno.mkdir(`${dir}/project-dir.world.glb`)
    await Deno.writeTextFile(`${dir}/project-dir.world.glb/inside`, 'x')
    await Deno.writeFile(`${dir}/real.glb`, exportOf([MINE]))
    await Deno.symlink(`${dir}/real.glb`, `${dir}/project-link.world.glb`)
    await Deno.writeFile(`${dir}/project-a.json`, exportOf([MINE]))
    assertEquals(await side([], dir).dropExportsHolding(MINE), 0)
    assert(await exists(`${dir}/project-dir.world.glb/inside`) && await exists(`${dir}/real.glb`) && await exists(`${dir}/project-a.json`))
    assert((await Deno.lstat(`${dir}/project-link.world.glb`)).isSymlink, 'a link is not followed, and not removed')
  })
})

Deno.test('a folder that is not there holds no export', async () => {
  assertEquals(await side([], '/nowhere/at/all').dropExportsHolding(MINE), 0)
})

Deno.test({
  name: 'an export that cannot be read is thrown, not skipped, so the scan is not reported deleted over a copy that may be there',
  ignore: !CAN_MAKE_A_PERMISSION_FAILURE,
}, async () => {
  await withDir(async (dir) => {
    await writeExport(dir, 'project-a', [MINE])
    await Deno.chmod(`${dir}/project-a.world.glb`, 0o000)
    try {
      await assertRejects(() => side([], dir).dropExportsHolding(MINE))
    } finally {
      await Deno.chmod(`${dir}/project-a.world.glb`, 0o644)
    }
    assertEquals(await side([], dir).dropExportsHolding(MINE), 1, 'and a second try, once it can be read, finishes it')
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
