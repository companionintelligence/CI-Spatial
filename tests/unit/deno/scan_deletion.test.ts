/**
 * Deleting a scan, from the files beside it to its place in the worlds (server/scan_deletion.ts), against real temporary
 * directories and a stand-in for the worlds.
 *
 * What these hold: what a deletion takes (the GLB, its sidecar, the optimizer's files, LingBot-Map's point cloud, the splat and
 * person files, the 4D folder, the SenseNova folders of the scan's own jobs, its sessions) and what it leaves (another scan whose
 * name begins the same way, a folder outside `.sensenova`); the order (the worlds go last, after every file); that a refusal
 * (a job running, a bad name) removes nothing; that a failure is a 500 with counts and no path, keeps the scan in its worlds and
 * lets a second try finish; that the scan is marked as being deleted while it is, and not after; and that clearing everything
 * leaves the sessions folder, the Places' photos and a scan that is still arriving.
 *
 * tests/unit/deno/keyframe_routes.test.ts runs the same module through the real server, with real jobs.
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { scanIdFor } from '../../../server/scan_id.ts'
import {
  type DeleteAllDeps,
  deleteAllScans,
  deleteScan,
  isPlainScanFilename,
  removeScanFiles,
  type ScanDeletionDeps,
} from '../../../server/scan_deletion.ts'
import { jobIsForScanBeingDeleted } from '../../../server/scan_job_guard.ts'
import { UNPUBLISHED_UPLOAD_MAX_AGE_MS } from '../../../server/session_deletion.ts'
import { cannotRemoveFromReadOnlyFolder } from './read_only_folders.ts'

/** Root can remove from a read-only folder, so a test that makes its failure that way is ignored there, not passed. */
const CAN_MAKE_A_PERMISSION_FAILURE = await cannotRemoveFromReadOnlyFolder()

const SPLAT = ['.splat-train.manifest.json', '.splat-detect.manifest.json', '.interactions.json', '.compressed.ply', '.splat.ply', '.sog']
const MINE = '100_room.glb'
const SIBLING = '100_room-two.glb'
const S1 = 'sess-11111111-1111-4111-8111-111111111111'
const S2 = 'sess-22222222-2222-4222-8222-222222222222'

interface Tree {
  root: string
  scans: string
  sessions: string
}

async function withTree(run: (tree: Tree) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: 'scan-deletion-' })
  const scans = `${root}/scans`
  const sessions = `${scans}/sessions`
  await Deno.mkdir(sessions, { recursive: true })
  try {
    await run({ root, scans, sessions })
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined)
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

/** Runs `work` with console.error recorded, so that a failure the code logs does not clutter the run. */
async function quiet<T>(work: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = []
  const saved = console.error
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
  try {
    return { result: await work(), logged }
  } finally {
    console.error = saved
  }
}

/** Every file the pipelines write beside a scan, plus the scan itself, with the given base name. */
async function makeScanWithEverything(scans: string, filename: string): Promise<string[]> {
  const base = filename.replace(/\.glb$/, '')
  const made: string[] = [filename, `${base}.json`, `${base}.opt.glb`, `${base}.lod1.glb`, `${base}.lod2.glb`, `${base}.manifest.json`, `${base}.lingbot.glb`]
  for (const suffix of SPLAT) made.push(`${base}${suffix}`)
  for (const name of made) await Deno.writeTextFile(`${scans}/${name}`, `content of ${name}`)
  await Deno.mkdir(`${scans}/${base}.4d`)
  await Deno.writeTextFile(`${scans}/${base}.4d/frame-00000.sog`, 'x')
  made.push(`${base}.4d`)
  return made
}

async function makeSession(sessions: string, id: string, record: Record<string, unknown> = {}): Promise<void> {
  await Deno.mkdir(`${sessions}/${id}`, { recursive: true })
  await Deno.writeFile(`${sessions}/${id}/kf-00000.jpg`, new Uint8Array(100))
  await Deno.writeTextFile(`${sessions}/${id}/session.json`, JSON.stringify({ sessionId: id, ...record }))
}

interface Calls {
  order: string[]
  worldsSawGlb: boolean | null
  /** How many worlds the stand-in says held something of the scan. */
  worldsHeld: number
}

function fakeDeps(tree: Tree, calls: Calls, overrides: Partial<ScanDeletionDeps> = {}): ScanDeletionDeps {
  return {
    scansDir: tree.scans,
    sessionsDir: tree.sessions,
    splatSuffixes: SPLAT,
    claimJobs: async () => {
      calls.order.push('claim')
      return { running: [], senseNovaJobIds: [] }
    },
    dropWorldExports: async () => {
      calls.order.push('exports')
      return 0
    },
    removeFromWorlds: async (filename) => {
      calls.order.push('worlds')
      calls.worldsSawGlb = await exists(`${tree.scans}/${filename}`)
      return calls.worldsHeld
    },
    ...overrides,
  }
}

// ── What a deletion takes, and what it leaves ───────────────────────────────────

Deno.test('a deletion takes the scan, everything the pipelines wrote beside it, its 4D folder and its sessions, and not a scan whose name begins the same', async () => {
  await withTree(async (tree) => {
    const mine = await makeScanWithEverything(tree.scans, MINE)
    const sibling = await makeScanWithEverything(tree.scans, SIBLING)
    await makeSession(tree.sessions, S1, { glbFilename: MINE })
    await makeSession(tree.sessions, S2, { glbFilename: SIBLING })
    const calls: Calls = { order: [], worldsSawGlb: null, worldsHeld: 1 }
    const reply = await deleteScan(MINE, fakeDeps(tree, calls))
    assertEquals(reply.status, 200, JSON.stringify(reply.body))
    for (const name of mine) assertFalse(await exists(`${tree.scans}/${name}`), `${name} went with the scan`)
    for (const name of sibling) assert(await exists(`${tree.scans}/${name}`), `${name} belongs to another scan and stays`)
    assertFalse(await exists(`${tree.sessions}/${S1}`))
    assert(await exists(`${tree.sessions}/${S2}`))
    const deleted = (reply.body['deleted'] as Record<string, unknown>)
    assertEquals([deleted['glb'], deleted['metadata'], deleted['keyframeSessions']], [true, true, 1])
    assertEquals(deleted['sidecars'], 4 + 1 + SPLAT.length + 1, 'the optimizer\'s four, the point cloud, the splat files and the 4D folder')
    assertEquals(reply.body['ok'], true)
  })
})

Deno.test('a finished SenseNova job\'s folder goes with its scan, and nothing outside .sensenova is reachable through a job id', async () => {
  await withTree(async (tree) => {
    await makeScanWithEverything(tree.scans, MINE)
    for (const folder of ['.sensenova/job-1-aaaa', '.sensenova/job-2-bbbb', '.sensenova/job-3-cccc', 'victim']) {
      await Deno.mkdir(`${tree.scans}/${folder}`, { recursive: true })
      await Deno.writeTextFile(`${tree.scans}/${folder}/out.png`, 'x')
    }
    const calls: Calls = { order: [], worldsSawGlb: null, worldsHeld: 1 }
    const reply = await deleteScan(MINE, fakeDeps(tree, calls, {
      claimJobs: async () => ({ running: [], senseNovaJobIds: ['job-1-aaaa', 'job-2-bbbb', '../victim', 'JOB-9-ZZZZ/../..'] }),
    }))
    assertEquals(reply.status, 200)
    assertFalse(await exists(`${tree.scans}/.sensenova/job-1-aaaa`))
    assertFalse(await exists(`${tree.scans}/.sensenova/job-2-bbbb`))
    assert(await exists(`${tree.scans}/.sensenova/job-3-cccc`), 'a job this scan never had is not touched')
    assert(await exists(`${tree.scans}/victim/out.png`), 'a job id is made into a name inside .sensenova, never a path')
  })
})

Deno.test('the worlds go last: every file is already gone when the scan is taken out of them', async () => {
  await withTree(async (tree) => {
    await makeScanWithEverything(tree.scans, MINE)
    const calls: Calls = { order: [], worldsSawGlb: null, worldsHeld: 1 }
    assertEquals((await deleteScan(MINE, fakeDeps(tree, calls))).status, 200)
    assertEquals(calls.order, ['claim', 'exports', 'worlds'], 'jobs are looked at first, the files go, the worlds are last')
    assertEquals(calls.worldsSawGlb, false, 'the GLB was already gone when the worlds were told')
  })
})

Deno.test('deleting a scan that is not there, and no world holds, is a 404, and deleting twice is that answer the second time', async () => {
  await withTree(async (tree) => {
    await makeScanWithEverything(tree.scans, MINE)
    const calls: Calls = { order: [], worldsSawGlb: null, worldsHeld: 1 }
    assertEquals((await deleteScan(MINE, fakeDeps(tree, calls))).status, 200)
    calls.worldsHeld = 0
    const again = await deleteScan(MINE, fakeDeps(tree, calls))
    assertEquals(again.status, 404)
    assertEquals(again.body, { error: 'Scan not found' })
  })
})

Deno.test('a scan whose files are already gone but that a world still lists is removed from the world, which is a 200, not a 404', async () => {
  await withTree(async (tree) => {
    const calls: Calls = { order: [], worldsSawGlb: null, worldsHeld: 2 }
    const reply = await deleteScan(MINE, fakeDeps(tree, calls))
    assertEquals(reply.status, 200)
    assertEquals((reply.body['deleted'] as Record<string, unknown>)['worlds'], 2)
    assertEquals(calls.order, ['claim', 'exports', 'worlds'])
  })
})

Deno.test('a world export that was removed counts as the scan having been there', async () => {
  await withTree(async (tree) => {
    const calls: Calls = { order: [], worldsSawGlb: null, worldsHeld: 1 }
    // Nothing on disk, but an export held a copy: a retry after a failure that came after the files went.
    const reply = await deleteScan(MINE, fakeDeps(tree, calls, { dropWorldExports: async () => 1 }))
    assertEquals(reply.status, 200)
    assertEquals((reply.body['deleted'] as Record<string, unknown>)['worldExports'], 1)
    assert(calls.order.includes('worlds'))
  })
})

// ── Refusals remove nothing ─────────────────────────────────────────────────────

Deno.test('a job running on the scan refuses the deletion, names the job, and removes nothing', async () => {
  await withTree(async (tree) => {
    const made = await makeScanWithEverything(tree.scans, MINE)
    await makeSession(tree.sessions, S1, { glbFilename: MINE })
    const calls: Calls = { order: [], worldsSawGlb: null, worldsHeld: 1 }
    const reply = await deleteScan(MINE, fakeDeps(tree, calls, {
      claimJobs: async () => ({ running: [{ jobId: 'job-7', type: 'splat-train' }], senseNovaJobIds: [] }),
    }))
    assertEquals(reply.status, 409)
    assertStringIncludes(String(reply.body['error']), 'still being processed')
    assertEquals(reply.body['running'], [{ jobId: 'job-7', type: 'splat-train' }])
    for (const name of made) assert(await exists(`${tree.scans}/${name}`), `${name} is still there`)
    assert(await exists(`${tree.sessions}/${S1}`))
    assertEquals(calls.order, [], 'no world was touched')
  })
})

Deno.test('a name that is not a plain scan name is refused before any file is looked at', async () => {
  await withTree(async (tree) => {
    await Deno.mkdir(`${tree.root}/victim`)
    await Deno.writeTextFile(`${tree.root}/victim/keep.glb`, 'keep')
    const calls: Calls = { order: [], worldsSawGlb: null, worldsHeld: 1 }
    for (const name of ['../victim/keep.glb', '..\\victim\\keep.glb', 'a/b.glb', '.hidden.glb', 'x\u0000.glb', 'x\u0001.glb', 'x\n.glb', 'x\u007f.glb', 'no-extension', '', 'a.glb.json']) {
      const reply = await deleteScan(name, fakeDeps(tree, calls))
      assertEquals(reply.status, 400, JSON.stringify(name))
      assertEquals(reply.body, { error: 'Invalid filename' })
    }
    assertEquals(calls.order, [])
    assert(await exists(`${tree.root}/victim/keep.glb`))
    assert(isPlainScanFilename('1794_a scan (2).glb'), 'an ordinary name with spaces and brackets is a name')
    assertFalse(isPlainScanFilename('x\u0000.glb'))
  })
})

// ── Failures are reported, never hidden ─────────────────────────────────────────

Deno.test('a file that cannot be removed is a 500 with counts and no path, the scan stays in its worlds, and a second try finishes', async () => {
  await withTree(async (tree) => {
    await makeScanWithEverything(tree.scans, MINE)
    // A derived file that is a folder with something in it cannot be removed as a file.
    await Deno.remove(`${tree.scans}/${MINE.replace(/\.glb$/, '')}.opt.glb`)
    await Deno.mkdir(`${tree.scans}/${MINE.replace(/\.glb$/, '')}.opt.glb`)
    await Deno.writeTextFile(`${tree.scans}/${MINE.replace(/\.glb$/, '')}.opt.glb/inside`, 'x')
    const calls: Calls = { order: [], worldsSawGlb: null, worldsHeld: 1 }
    const { result: reply, logged } = await quiet(() => deleteScan(MINE, fakeDeps(tree, calls)))
    assertEquals(reply.status, 500)
    assertStringIncludes(String(reply.body['error']), 'the scan was kept')
    assertEquals((reply.body['files'] as Record<string, unknown>)['failed'], 1)
    assertFalse(JSON.stringify(reply.body).includes(tree.root), 'the reply names no path')
    assertFalse(logged.join('\n').includes(tree.root), 'and neither does the log')
    assertFalse(calls.order.includes('worlds'), 'the worlds keep the scan, so deleting it again is possible')
    assertFalse(calls.order.includes('exports'))
    // "The scan was kept" is true: its GLB and its sidecar, which names its sessions and its Place, are still here.
    assert(await exists(`${tree.scans}/${MINE}`), 'the GLB is kept')
    assert(await exists(`${tree.scans}/${MINE.replace(/\.glb$/, '.json')}`), 'and so is the sidecar')

    await Deno.remove(`${tree.scans}/${MINE.replace(/\.glb$/, '')}.opt.glb`, { recursive: true })
    const retry = await deleteScan(MINE, fakeDeps(tree, calls))
    assertEquals(retry.status, 200, 'the world still listed the scan, so taking it out of the world finishes the job')
    assert(calls.order.includes('worlds'))
  })
})

Deno.test('a session that cannot be removed is a 500, and no file of the scan has gone yet', async () => {
  await withTree(async (tree) => {
    await makeScanWithEverything(tree.scans, MINE)
    await makeSession(tree.sessions, S1, { glbFilename: MINE })
    // A session folder that is a link is refused, not followed.
    await Deno.remove(`${tree.sessions}/${S1}`, { recursive: true })
    await Deno.mkdir(`${tree.root}/elsewhere`)
    await Deno.symlink(`${tree.root}/elsewhere`, `${tree.sessions}/${S1}`)
    await Deno.writeTextFile(`${tree.scans}/${MINE.replace(/\.glb$/, '.json')}`, JSON.stringify({ sessionId: S1 }))
    const calls: Calls = { order: [], worldsSawGlb: null, worldsHeld: 1 }
    const reply = await deleteScan(MINE, fakeDeps(tree, calls))
    assertEquals(reply.status, 500)
    assertStringIncludes(String(reply.body['error']), 'camera frames')
    assert(await exists(`${tree.scans}/${MINE}`), 'the scan is still here')
    assert(await exists(`${tree.root}/elsewhere`), 'what the link points at is untouched')
  })
})

Deno.test('whatever the world side throws, the reply is a 500 with a fixed message that names no path', async () => {
  await withTree(async (tree) => {
    await makeScanWithEverything(tree.scans, MINE)
    const calls: Calls = { order: [], worldsSawGlb: null, worldsHeld: 1 }
    const { result: reply, logged } = await quiet(() => deleteScan(MINE, fakeDeps(tree, calls, {
      removeFromWorlds: () => Promise.reject(new Deno.errors.PermissionDenied(`write '${tree.root}/worlds/default.json'`)),
    })))
    assertEquals(reply.status, 500)
    assertFalse(JSON.stringify(reply.body).includes(tree.root), 'the message is not the error\'s')
    assertEquals(logged, ['[scan delete] stopped on an error (PermissionDenied)'])
  })
})

// ── The mark ────────────────────────────────────────────────────────────────────

Deno.test('the scan is marked as being deleted while the deletion runs, by id and by filename, and not after, whatever the outcome', async () => {
  await withTree(async (tree) => {
    await makeScanWithEverything(tree.scans, MINE)
    const marks: boolean[] = []
    const byId = { scanId: scanIdFor(MINE) }
    const byFilename = { payload: { filename: MINE } }
    const spy = (during: string) => async (): Promise<never[] | number> => {
      marks.push(jobIsForScanBeingDeleted(byId) && jobIsForScanBeingDeleted(byFilename))
      return during === 'claim' ? [] : 0
    }
    const calls: Calls = { order: [], worldsSawGlb: null, worldsHeld: 1 }
    const ok = await deleteScan(MINE, fakeDeps(tree, calls, {
      claimJobs: async () => {
        marks.push(jobIsForScanBeingDeleted(byId) && jobIsForScanBeingDeleted(byFilename))
        return { running: [], senseNovaJobIds: [] }
      },
      dropWorldExports: async () => {
        await spy('exports')()
        return 0
      },
    }))
    assertEquals(ok.status, 200)
    assertEquals(marks, [true, true], 'marked when jobs were looked at, and still when the exports went')
    assertFalse(jobIsForScanBeingDeleted(byId) || jobIsForScanBeingDeleted(byFilename), 'lifted after a deletion')

    const refused = await deleteScan(MINE, fakeDeps(tree, calls, { claimJobs: async () => ({ running: [{ jobId: 'j', type: 'splat-train' }], senseNovaJobIds: [] }) }))
    assertEquals(refused.status, 409)
    assertFalse(jobIsForScanBeingDeleted(byId), 'lifted after a refusal')

    const { result: failed } = await quiet(() => deleteScan(MINE, fakeDeps(tree, calls, { claimJobs: () => Promise.reject(new Error('boom')) })))
    assertEquals(failed.status, 500)
    assertFalse(jobIsForScanBeingDeleted(byId), 'lifted after a failure')
  })
})

// ── removeScanFiles ─────────────────────────────────────────────────────────────

Deno.test('removing a scan\'s files counts each kind, treats what is gone as removed work done, and attempts every path', async () => {
  await withTree(async (tree) => {
    const base = MINE.replace(/\.glb$/, '')
    await Deno.writeTextFile(`${tree.scans}/${MINE}`, 'g')
    await Deno.writeTextFile(`${tree.scans}/${base}.lingbot.glb`, 'l')
    const first = await removeScanFiles({ scansDir: tree.scans, filename: MINE, splatSuffixes: SPLAT })
    assertEquals(first, { glb: true, metadata: false, derived: 1, failed: 0 })
    const second = await removeScanFiles({ scansDir: tree.scans, filename: MINE, splatSuffixes: SPLAT })
    assertEquals(second, { glb: false, metadata: false, derived: 0, failed: 0 }, 'a second run finds nothing and fails nothing')

    // One path that fails does not hide the others.
    await Deno.writeTextFile(`${tree.scans}/${MINE}`, 'g')
    await Deno.mkdir(`${tree.scans}/${base}.manifest.json`)
    await Deno.writeTextFile(`${tree.scans}/${base}.manifest.json/inside`, 'x')
    await Deno.writeTextFile(`${tree.scans}/${base}.splat.ply`, 'p')
    const partial = await quiet(() => removeScanFiles({ scansDir: tree.scans, filename: MINE, splatSuffixes: SPLAT }))
    assertEquals(partial.result, { glb: false, metadata: false, derived: 1, failed: 1 }, 'the scan itself is not removed while anything made from it is left')
    assertFalse(await exists(`${tree.scans}/${base}.splat.ply`), 'a path after the one that failed was still attempted')
    assert(await exists(`${tree.scans}/${MINE}`), 'the GLB is still here, so the scan can be deleted again')

    // With the obstacle gone the scan goes, GLB first, and the sidecar with it.
    await Deno.remove(`${tree.scans}/${base}.manifest.json`, { recursive: true })
    await Deno.writeTextFile(`${tree.scans}/${base}.json`, '{}')
    assertEquals(await removeScanFiles({ scansDir: tree.scans, filename: MINE, splatSuffixes: SPLAT }), { glb: true, metadata: true, derived: 0, failed: 0 })
  })
})

Deno.test('the sidecar stays while the GLB does: when the GLB cannot be removed, the scan keeps its record of its sessions and its Place', async () => {
  await withTree(async (tree) => {
    const base = MINE.replace(/\.glb$/, '')
    // A GLB that is a folder with something in it cannot be removed as a file.
    await Deno.mkdir(`${tree.scans}/${MINE}`)
    await Deno.writeTextFile(`${tree.scans}/${MINE}/inside`, 'x')
    await Deno.writeTextFile(`${tree.scans}/${base}.json`, JSON.stringify({ sessionId: S1 }))
    const outcome = await quiet(() => removeScanFiles({ scansDir: tree.scans, filename: MINE, splatSuffixes: SPLAT }))
    assertEquals(outcome.result, { glb: false, metadata: false, derived: 0, failed: 1 })
    assert(await exists(`${tree.scans}/${base}.json`), 'the sidecar is what names the sessions, so it stays')
  })
})

// ── Clearing everything ─────────────────────────────────────────────────────────

function allDeps(tree: Tree, calls: string[], overrides: Partial<DeleteAllDeps> = {}): DeleteAllDeps {
  return {
    scansDir: tree.scans,
    sessionsDir: tree.sessions,
    splatSuffixes: SPLAT,
    runningJobs: async () => {
      calls.push('running')
      return []
    },
    dropAllWorldExports: async () => {
      calls.push('exports')
      return 0
    },
    removeAllFromWorlds: async () => {
      calls.push('worlds')
    },
    ...overrides,
  }
}

Deno.test('clearing everything removes the scans, what was made from them and every session, and leaves Places\' photos, the sessions folder and unrelated files', async () => {
  await withTree(async (tree) => {
    await makeScanWithEverything(tree.scans, MINE)
    await makeScanWithEverything(tree.scans, SIBLING)
    await makeSession(tree.sessions, S1)
    await makeSession(tree.sessions, S2, { source: 'video-ingest' })
    await Deno.mkdir(`${tree.scans}/.sensenova/job-1`, { recursive: true })
    await Deno.writeTextFile(`${tree.scans}/.sensenova/job-1/depth.png`, 'x')
    await Deno.mkdir(`${tree.scans}/projects/proj-1`, { recursive: true })
    await Deno.writeTextFile(`${tree.scans}/projects/proj-1/ref-landmark.jpg`, 'photo')
    await Deno.writeTextFile(`${tree.scans}/notes.txt`, 'not a scan')
    const calls: string[] = []
    const reply = await deleteAllScans(allDeps(tree, calls))
    assertEquals(reply.status, 200, JSON.stringify(reply.body))
    assertEquals(reply.body['keyframeSessions'], 2)
    const left: string[] = []
    for await (const entry of Deno.readDir(tree.scans)) left.push(entry.name)
    assertEquals(left.sort(), ['notes.txt', 'projects', 'sessions'], 'only what is not scan data is left')
    assert(await exists(`${tree.scans}/projects/proj-1/ref-landmark.jpg`), 'a Place\'s photos are not scan data: they stay')
    assertEquals(calls, ['running', 'exports', 'worlds'])
    assertEquals(reply.body['deleted'], 2 * (1 + 1 + 4 + 1 + SPLAT.length + 1) + 1, 'every file and folder removed is counted')
  })
})

Deno.test('clearing everything leaves a scan that is still arriving, and takes one that was cut short', async () => {
  await withTree(async (tree) => {
    await Deno.writeTextFile(`${tree.scans}/fresh.glb.part`, 'arriving')
    await Deno.writeTextFile(`${tree.scans}/old.glb.part`, 'cut short')
    const long = new Date(Date.now() - UNPUBLISHED_UPLOAD_MAX_AGE_MS - 60_000)
    await Deno.utime(`${tree.scans}/old.glb.part`, long, long)
    const reply = await deleteAllScans(allDeps(tree, []))
    assertEquals(reply.status, 200)
    assert(await exists(`${tree.scans}/fresh.glb.part`), 'an upload in flight keeps its file')
    assertFalse(await exists(`${tree.scans}/old.glb.part`), 'one that will never be published is camera data and goes')
  })
})

Deno.test('clearing everything is refused while a job runs on a scan, and removes and touches nothing', async () => {
  await withTree(async (tree) => {
    await makeScanWithEverything(tree.scans, MINE)
    await makeSession(tree.sessions, S1)
    const calls: string[] = []
    const reply = await deleteAllScans(allDeps(tree, calls, {
      runningJobs: async () => [{ jobId: 'job-1', type: 'optimize-scan' }],
    }))
    assertEquals(reply.status, 409)
    assertEquals(reply.body['running'], [{ jobId: 'job-1', type: 'optimize-scan' }])
    assert(await exists(`${tree.scans}/${MINE}`))
    assert(await exists(`${tree.sessions}/${S1}`))
    assertEquals(calls, [])
    assertFalse(jobIsForScanBeingDeleted({ scanId: scanIdFor(MINE) }), 'the mark is lifted')
  })
})

Deno.test({
  name: 'clearing everything that cannot finish is a 500 with counts and no path, and leaves the worlds as they were',
  ignore: !CAN_MAKE_A_PERMISSION_FAILURE,
}, async () => {
  await withTree(async (tree) => {
    await makeScanWithEverything(tree.scans, MINE)
    await makeSession(tree.sessions, S1)
    // The scans folder cannot be written to, so no file in it can be removed. The sessions folder inside it still can.
    await Deno.chmod(tree.scans, 0o555)
    const calls: string[] = []
    try {
      const { result: reply, logged } = await quiet(() => deleteAllScans(allDeps(tree, calls)))
      assertEquals(reply.status, 500)
      assertStringIncludes(String(reply.body['error']), 'the worlds were left as they were')
      assert((reply.body['failed'] as number) > 0)
      assertFalse(JSON.stringify(reply.body).includes(tree.root), 'the reply names no path')
      assertFalse(logged.join('\n').includes(tree.root), 'and neither does the log')
      assertEquals(calls, ['running'], 'no export was dropped and no world was emptied: the scans are still listed')
    } finally {
      await Deno.chmod(tree.scans, 0o755)
    }
    const retry = await deleteAllScans(allDeps(tree, []))
    assertEquals(retry.status, 200, 'a second try finishes the job')
    assertFalse(await exists(`${tree.scans}/${MINE}`))
  })
})

Deno.test('a session that cannot be removed stops clearing before any scan file goes', async () => {
  await withTree(async (tree) => {
    await makeScanWithEverything(tree.scans, MINE)
    // A session folder that is a regular file, as damage leaves one, is refused, not removed.
    await Deno.writeTextFile(`${tree.sessions}/${S1}`, 'not a directory')
    const calls: string[] = []
    const reply = await deleteAllScans(allDeps(tree, calls))
    // Only a real directory with a session id is a session here, so a file with one is not this sweep's to remove: nothing fails.
    assertEquals(reply.status, 200)
    assert(await exists(`${tree.sessions}/${S1}`), 'a file that is not a session is left')
  })
})

Deno.test('whatever the world side throws, clearing everything answers a fixed 500 that names no path', async () => {
  await withTree(async (tree) => {
    const { result: reply, logged } = await quiet(() => deleteAllScans(allDeps(tree, [], {
      removeAllFromWorlds: () => Promise.reject(new Deno.errors.PermissionDenied(`write '${tree.root}/worlds'`)),
    })))
    assertEquals(reply.status, 500)
    assertFalse(JSON.stringify(reply.body).includes(tree.root))
    assertEquals(logged, ['[scans clear] stopped on an error (PermissionDenied)'])
  })
})
