/**
 * Deleting a scan's camera frames (server/session_deletion.ts), against real temporary directories.
 *
 * `DELETE /scans/:filename` used to leave `scans/sessions/<id>/` behind: the keyframe photographs of a room,
 * their poses and every file a job wrote beside them. These tests hold the rules that fix it: which sessions a
 * scan owns (its sidecar's, and every session finalized against it), that a session another scan still names
 * is kept, that only a real directory directly under the sessions folder is ever removed, that a failure
 * reports itself and leaves the scan's link readable, and that doing it twice is a success.
 *
 * tests/unit/deno/keyframe_routes.test.ts runs the same rules through the real server's routes.
 */
import { assert, assertEquals, assertFalse, assertRejects } from 'jsr:@std/assert@^1.0.0'
import { loadSessionIndex } from '../../../server/scan_index.ts'
import {
  collectScanSessionLinks,
  deleteAllSessions,
  deleteScanSessions,
  deleteSessionDirectories,
  deleteStreamedSession,
  directoryBytes,
  planScanSessionDeletion,
  removeSessionDirectory,
  sessionIdsLinkedToScan,
  UNPUBLISHED_UPLOAD_MAX_AGE_MS,
} from '../../../server/session_deletion.ts'
import { queueKeyframeWrite } from '../../../server/wp-a-keyframes.ts'
import { cannotRemoveFromReadOnlyFolder } from './read_only_folders.ts'

/** Root can remove from a read-only folder, so a test that makes its failure that way is ignored there, not passed. */
const CAN_MAKE_A_PERMISSION_FAILURE = await cannotRemoveFromReadOnlyFolder()

interface Tree {
  root: string
  scans: string
  sessions: string
}

const S1 = 'sess-11111111-1111-4111-8111-111111111111'
const S2 = 'sess-22222222-2222-4222-8222-222222222222'
const S3 = 'sess-33333333-3333-4333-8333-333333333333'
const S4 = 'sess-44444444-4444-4444-8444-444444444444'

async function withTree(run: (tree: Tree) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: 'keyframe-deletion-' })
  const scans = `${root}/scans`
  const sessions = `${scans}/sessions`
  await Deno.mkdir(sessions, { recursive: true })
  try {
    await run({ root, scans, sessions })
  } finally {
    // A test that made a directory read-only must not leave the temp folder behind.
    await restoreWritable(root)
    await Deno.remove(root, { recursive: true }).catch(() => undefined)
  }
}

async function restoreWritable(dir: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory) {
        await Deno.chmod(path, 0o755).catch(() => undefined)
        await restoreWritable(path)
      }
    }
  } catch { /* gone */ }
}

interface SessionSpec {
  glbFilename?: string | null
  source?: string
  captureKind?: string
  frames?: number
  /** The scan the stream last exported before this session opened, which this session follows. */
  followsGlbFilename?: string
  /** Extra files, by path under the session, as a job would leave them. */
  extra?: Record<string, string>
}

/** A session directory as the server writes one: a record, a frame log and the frames. */
async function makeSession(sessions: string, id: string, spec: SessionSpec = {}): Promise<string> {
  const dir = `${sessions}/${id}`
  await Deno.mkdir(dir, { recursive: true })
  const frames = spec.frames ?? 3
  const lines: string[] = []
  for (let i = 0; i < frames; i++) {
    const name = `kf-${String(i).padStart(5, '0')}.jpg`
    await Deno.writeFile(`${dir}/${name}`, new Uint8Array(1000 + i))
    lines.push(JSON.stringify({ index: i, file: name, bytes: 1000 + i }))
  }
  await Deno.writeTextFile(`${dir}/keyframes.jsonl`, lines.join('\n') + '\n')
  const record: Record<string, unknown> = { sessionId: id, startedAt: '2026-11-01T10:00:00.000Z', keyframeCount: frames }
  if (spec.glbFilename !== undefined) {
    record['finalizedAt'] = '2026-11-01T10:05:00.000Z'
    record['glbFilename'] = spec.glbFilename
  }
  if (spec.source) record['source'] = spec.source
  if (spec.captureKind) record['captureKind'] = spec.captureKind
  if (spec.followsGlbFilename) record['followsGlbFilename'] = spec.followsGlbFilename
  await Deno.writeTextFile(`${dir}/session.json`, JSON.stringify(record, null, 2))
  for (const [path, text] of Object.entries(spec.extra ?? {})) {
    await Deno.mkdir(`${dir}/${path.split('/').slice(0, -1).join('/')}`.replace(/\/$/, ''), { recursive: true })
    await Deno.writeTextFile(`${dir}/${path}`, text)
  }
  return dir
}

/** A scan as an upload stores it: the GLB and its sidecar. */
async function makeScan(scans: string, filename: string, meta: Record<string, unknown> = {}): Promise<void> {
  await Deno.writeFile(`${scans}/${filename}`, new Uint8Array(64))
  await Deno.writeTextFile(`${scans}/${filename.replace(/\.glb$/, '.json')}`, JSON.stringify(meta))
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path)
    return true
  } catch {
    return false
  }
}

// ── Which sessions a scan owns ──────────────────────────────────────────────────

Deno.test('a scan owns the session its sidecar names and every session finalized against it', async () => {
  await withTree(async ({ sessions }) => {
    await makeSession(sessions, S1, { glbFilename: '100_room.glb' })
    await makeSession(sessions, S2, { glbFilename: '100_room.glb' })
    await makeSession(sessions, S3, { glbFilename: '200_other.glb' })
    await makeSession(sessions, S4)
    const index = await loadSessionIndex(sessions)

    const owned = sessionIdsLinkedToScan(index, '100_room.glb', { sessionId: S4 })
    assertEquals([...owned].sort(), [S1, S2, S4].sort(), 'the sidecar link and both glbFilename links, not the other scan\'s')
    assertEquals(sessionIdsLinkedToScan(index, '100_room.glb', {}).sort(), [S1, S2], 'a sidecar that is gone still leaves the finalize links')
    assertEquals(sessionIdsLinkedToScan(index, '300_none.glb', {}), [])
  })
})

Deno.test('an id that is not a server session id is never a link', async () => {
  await withTree(async ({ sessions }) => {
    const index = await loadSessionIndex(sessions)
    for (const id of ['local-1234', 'session-1787174216556', '../../etc', 'sess-', 'sess-A', '', 42, null]) {
      assertEquals(sessionIdsLinkedToScan(index, 'a.glb', { sessionId: id }), [], `${String(id)} is not a session`)
    }
  })
})

Deno.test('a scan made from an upload owns the session its synthetic filename names', async () => {
  await withTree(async ({ sessions }) => {
    await makeSession(sessions, S1, { source: 'photo-ingest' })
    const index = await loadSessionIndex(sessions)
    assertEquals(sessionIdsLinkedToScan(index, `${S1}.glb`, {}), [S1])
  })
})

Deno.test('collectScanSessionLinks reads every GLB scan and every upload scan, and nothing under sessions/', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, S1, { glbFilename: '100_a.glb' })
    await makeSession(sessions, S2, { source: 'video-ingest' })
    await makeScan(scans, '100_a.glb', { sessionId: S1 })
    await makeScan(scans, '200_b.glb', {})
    // A derived file is not a scan; an upload scan has a sidecar and no GLB.
    await Deno.writeFile(`${scans}/100_a.opt.glb`, new Uint8Array(8))
    await Deno.writeTextFile(`${scans}/${S2}.json`, JSON.stringify({ sessionId: S2, source: 'video-ingest' }))
    const links = await collectScanSessionLinks(scans, await loadSessionIndex(sessions))
    assertEquals([...links.keys()].sort(), ['100_a.glb', '200_b.glb', `${S2}.glb`].sort())
    assertEquals(links.get('100_a.glb'), [S1])
    assertEquals(links.get('200_b.glb'), [])
    assertEquals(links.get(`${S2}.glb`), [S2])
  })
})

Deno.test('a session another scan still names is kept, with the scans that hold it', () => {
  const links = new Map<string, string[]>([
    ['a.glb', [S1, S2]],
    ['b.glb', [S2, S3]],
    ['c.glb', []],
  ])
  const plan = planScanSessionDeletion([S1, S2], links, 'a.glb')
  assertEquals(plan.delete, [S1])
  assertEquals(plan.retained, [{ sessionId: S2, usedBy: ['b.glb'] }])
  assertEquals(planScanSessionDeletion([S4], links, 'c.glb').delete, [S4], 'a scan with no other user takes everything it names')
  assertEquals(planScanSessionDeletion([S1, S1], links, 'a.glb').delete, [S1], 'an id named twice is planned once')
})

// ── Taking a session away ───────────────────────────────────────────────────────

Deno.test('a deleted session is gone with everything a job wrote in it, and the report counts its bytes', async () => {
  await withTree(async ({ sessions }) => {
    const dir = await makeSession(sessions, S1, {
      glbFilename: 'a.glb',
      extra: { 'colmap/images/kf-00000.jpg': 'x'.repeat(500), 'lingbot-map.poses.json': '[]' },
    })
    const before = await directoryBytes(dir)
    const report = await deleteSessionDirectories(sessions, [S1])
    assertEquals(report.deleted, [S1])
    assertEquals(report.failed, [])
    assertEquals(report.missing, [])
    assertEquals(report.bytes, before, 'bytes is what the session held, measured before it went')
    assert(before >= 1000 + 1001 + 1002 + 500 + 2, `at least the frames and the job output: ${before}`)
    assertFalse(await exists(dir))
  })
})

Deno.test('deleting a session twice is a success the second time', async () => {
  await withTree(async ({ sessions }) => {
    await makeSession(sessions, S1)
    assertEquals((await deleteSessionDirectories(sessions, [S1])).deleted, [S1])
    const again = await deleteSessionDirectories(sessions, [S1])
    assertEquals(again.deleted, [])
    assertEquals(again.missing, [S1])
    assertEquals(again.failed, [])
  })
})

Deno.test('an id that is not a session id touches nothing, however it is spelled', async () => {
  await withTree(async ({ root, sessions }) => {
    await Deno.mkdir(`${root}/victim`, { recursive: true })
    await Deno.writeTextFile(`${root}/victim/keep.txt`, 'keep')
    await Deno.mkdir(`${sessions}/other`, { recursive: true })
    const report = await deleteSessionDirectories(sessions, ['../victim', '..', '.', 'other', 'sess-/../../victim', 'local-abc', ''])
    assertEquals(report.deleted, [])
    assertEquals(report.failed.length, 7)
    assert(report.failed.every((item) => item.reason === 'InvalidSessionId'))
    assert(await exists(`${root}/victim/keep.txt`))
    assert(await exists(`${sessions}/other`))
  })
})

Deno.test('a session id that is a link is refused, and what it points at is left alone', async () => {
  await withTree(async ({ root, sessions }) => {
    await Deno.mkdir(`${root}/outside`, { recursive: true })
    await Deno.writeTextFile(`${root}/outside/precious.txt`, 'precious')
    await Deno.symlink(`${root}/outside`, `${sessions}/${S1}`)
    const report = await deleteSessionDirectories(sessions, [S1])
    assertEquals(report.deleted, [])
    assertEquals(report.failed, [{ sessionId: S1, reason: 'NotADirectory' }])
    assert(await exists(`${root}/outside/precious.txt`), 'the target of the link is untouched')
    assert((await Deno.lstat(`${sessions}/${S1}`)).isSymlink, 'the link is left as it was')
  })
})

Deno.test('a link inside a session is removed as a link, and what it points at is left alone', async () => {
  await withTree(async ({ root, sessions }) => {
    await Deno.mkdir(`${root}/outside`, { recursive: true })
    await Deno.writeTextFile(`${root}/outside/precious.txt`, 'precious')
    const dir = await makeSession(sessions, S1)
    await Deno.symlink(`${root}/outside`, `${dir}/shortcut`)
    const report = await deleteSessionDirectories(sessions, [S1])
    assertEquals(report.deleted, [S1])
    assert(await exists(`${root}/outside/precious.txt`), 'removal did not follow the link')
    assertFalse(await exists(dir))
  })
})

Deno.test({
  name: 'a failure is reported for that session, the others still go, and the failed one keeps its record',
  ignore: !CAN_MAKE_A_PERMISSION_FAILURE,
}, async () => {
  await withTree(async ({ sessions }) => {
    const stuck = await makeSession(sessions, S1, { glbFilename: 'a.glb', extra: { 'work/output.bin': 'data' } })
    await makeSession(sessions, S2, { glbFilename: 'b.glb' })
    await Deno.chmod(`${stuck}/work`, 0o555)

    const report = await deleteSessionDirectories(sessions, [S1, S2])
    assertEquals(report.deleted, [S2], 'the other session was removed')
    assertEquals(report.failed.length, 1)
    assertEquals(report.failed[0]!.sessionId, S1)
    assert(report.failed[0]!.reason.length > 0 && !report.failed[0]!.reason.includes(sessions), 'a reason names the error, never a path')
    // The record is what finds the session again, so it is removed last and is still here.
    assert(await exists(`${stuck}/session.json`), 'session.json outlives a removal that stopped half way')
    assertEquals((await loadSessionIndex(sessions)).byGlb.get('a.glb')?.['sessionId'], S1, 'the link still resolves')

    await Deno.chmod(`${stuck}/work`, 0o755)
    const retry = await deleteSessionDirectories(sessions, [S1])
    assertEquals(retry.deleted, [S1], 'a second try finishes the job')
    assertFalse(await exists(stuck))
  })
})

Deno.test('a frame being written finishes before its session is removed, and is removed with it', async () => {
  await withTree(async ({ sessions }) => {
    const dir = await makeSession(sessions, S1)
    let writeDone = false
    const writing = queueKeyframeWrite(dir, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      await Deno.writeFile(`${dir}/kf-00099.jpg`, new Uint8Array(10))
      writeDone = true
    })
    const report = await deleteSessionDirectories(sessions, [S1])
    await writing
    assert(writeDone, 'the write was not interrupted')
    assertEquals(report.deleted, [S1])
    assertEquals(report.failed, [])
    assertFalse(await exists(dir), 'the late frame did not leave the directory behind')
  })
})

// ── Deleting a scan ─────────────────────────────────────────────────────────────

Deno.test('deleting a scan removes the sessions only it names, and keeps and reports the one another scan names', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, S1, { glbFilename: '100_a.glb' })
    await makeSession(sessions, S2, { glbFilename: '100_a.glb' })
    await makeSession(sessions, S3, { glbFilename: '100_a.glb' })
    await makeSession(sessions, S4, { glbFilename: '200_unrelated.glb' })
    await makeScan(scans, '100_a.glb', { sessionId: S1 })
    await makeScan(scans, '200_b.glb', { sessionId: S3 })
    await makeScan(scans, '200_unrelated.glb', { sessionId: S4 })

    const result = await deleteScanSessions({ scansDir: scans, sessionsDir: sessions, filename: '100_a.glb' })
    assertEquals([...result.report.deleted].sort(), [S1, S2].sort())
    assertEquals(result.plan.retained, [{ sessionId: S3, usedBy: ['200_b.glb'] }])
    assertFalse(await exists(`${sessions}/${S1}`))
    assertFalse(await exists(`${sessions}/${S2}`))
    assert(await exists(`${sessions}/${S3}`), 'the session scan b still names is kept')
    assert(await exists(`${sessions}/${S4}`), 'another scan\'s session is not touched')

    // When the last scan that names it goes, so does the session. The first scan's own files are gone by then.
    await Deno.remove(`${scans}/100_a.glb`)
    await Deno.remove(`${scans}/100_a.json`)
    const last = await deleteScanSessions({ scansDir: scans, sessionsDir: sessions, filename: '200_b.glb' })
    assertEquals(last.report.deleted, [S3])
    assertFalse(await exists(`${sessions}/${S3}`))
  })
})

Deno.test('deleting a scan again, after its sidecar is gone, still finds the sessions that name it', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, S1, { glbFilename: '100_a.glb' })
    await makeScan(scans, '100_a.glb', { sessionId: S1 })
    await Deno.remove(`${scans}/100_a.json`)
    await Deno.remove(`${scans}/100_a.glb`)
    const result = await deleteScanSessions({ scansDir: scans, sessionsDir: sessions, filename: '100_a.glb' })
    assertEquals(result.report.deleted, [S1], 'the finalize record is the link that is left')
    const again = await deleteScanSessions({ scansDir: scans, sessionsDir: sessions, filename: '100_a.glb' })
    assertEquals(again.report.deleted, [])
    assertEquals(again.report.failed, [])
  })
})

Deno.test('deleting a scan made from an upload removes the session that is its data', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, S1, { source: 'photo-ingest' })
    await Deno.writeTextFile(`${scans}/${S1}.json`, JSON.stringify({ sessionId: S1, source: 'photo-ingest' }))
    const result = await deleteScanSessions({ scansDir: scans, sessionsDir: sessions, filename: `${S1}.glb` })
    assertEquals(result.report.deleted, [S1])
  })
})

Deno.test('a scan with no session deletes nothing and fails nothing', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, S1, { glbFilename: '999_other.glb' })
    await makeScan(scans, '100_a.glb', {})
    const result = await deleteScanSessions({ scansDir: scans, sessionsDir: sessions, filename: '100_a.glb' })
    assertEquals(result.report, { deleted: [], missing: [], failed: [], bytes: 0 })
    assert(await exists(`${sessions}/${S1}`))
  })
})

Deno.test('deleting every session removes the session folders and leaves what is not one', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, S1)
    await makeSession(sessions, S2, { source: 'video-ingest' })
    await Deno.mkdir(`${scans}/projects`, { recursive: true })
    await Deno.mkdir(`${sessions}/notes`, { recursive: true })
    await Deno.writeTextFile(`${sessions}/readme.txt`, 'not a session')
    const report = await deleteAllSessions(sessions)
    assertEquals([...report.deleted].sort(), [S1, S2].sort())
    assert(await exists(`${sessions}/notes`))
    assert(await exists(`${sessions}/readme.txt`))
    assert(await exists(`${scans}/projects`))
    assertEquals((await deleteAllSessions(`${scans}/no-such-folder`)).deleted, [], 'a missing folder holds no sessions')
  })
})

// ── DELETE /sessions/:id ────────────────────────────────────────────────────────

Deno.test('deleting one streamed session: gone with its frames, then 404 the second time', async () => {
  await withTree(async ({ sessions }) => {
    await makeSession(sessions, S1, { glbFilename: 'a.glb' })
    const first = await deleteStreamedSession(sessions, S1)
    assertEquals(first.status, 200)
    assertEquals(first.body['ok'], true)
    assert(typeof first.body['bytes'] === 'number' && first.body['bytes'] > 0)
    assertFalse(await exists(`${sessions}/${S1}`))
    assertEquals((await deleteStreamedSession(sessions, S1)).status, 404, 'already gone reads as done')
  })
})

Deno.test('deleting one session refuses a bad id, and the session an upload is made from', async () => {
  await withTree(async ({ sessions }) => {
    assertEquals((await deleteStreamedSession(sessions, '../x')).status, 400)
    assertEquals((await deleteStreamedSession(sessions, 'local-1')).status, 400)
    await makeSession(sessions, S1, { source: 'video-ingest' })
    await makeSession(sessions, S2, { captureKind: 'person' })
    for (const id of [S1, S2]) {
      const reply = await deleteStreamedSession(sessions, id)
      assertEquals(reply.status, 409, `${id} is a scan's own data`)
      assert(await exists(`${sessions}/${id}`), 'nothing was removed')
    }
  })
})

// ── A file that arrives while a session is being removed ────────────────────────

Deno.test('a file written after the last listing is taken with the folder, not left in a folder nothing points to', async () => {
  await withTree(async ({ sessions }) => {
    const dir = await makeSession(sessions, S1, { glbFilename: 'a.glb' })
    let wrote = false
    // A reconstruction job writing beside the frames, after the removal has looked and found only the record left.
    const removed = await removeSessionDirectory(dir, {
      afterPass: async (folder, { quiet }) => {
        if (!quiet || wrote) return
        wrote = true
        await Deno.writeTextFile(`${folder}/lingbot-map.poses.json`, '[]')
        await Deno.mkdir(`${folder}/colmap`)
        await Deno.writeTextFile(`${folder}/colmap/points.bin`, 'x')
      },
    })
    assert(wrote, 'the late writer ran')
    assertEquals(removed, true)
    assertFalse(await exists(dir), 'the folder is gone with what arrived late, so no unlinked folder is left')
    assertEquals((await loadSessionIndex(sessions)).bySessionId.size, 0)
  })
})

Deno.test({
  name: 'while files keep arriving, the record is removed last: a failure on a late file leaves the session findable',
  ignore: !CAN_MAKE_A_PERMISSION_FAILURE,
}, async () => {
  await withTree(async ({ sessions }) => {
    const dir = await makeSession(sessions, S1, { glbFilename: 'a.glb' })
    let stuck = ''
    try {
      await assertRejects(() =>
        removeSessionDirectory(dir, {
          afterPass: async (folder, { pass, quiet }) => {
            if (pass !== 0 || quiet) return
            // A folder that cannot be emptied, written after the first listing: the next listing finds it and fails on it.
            stuck = `${folder}/late`
            await Deno.mkdir(stuck)
            await Deno.writeTextFile(`${stuck}/out.bin`, 'x')
            await Deno.chmod(stuck, 0o555)
          },
        })
      )
      assert(await exists(`${dir}/session.json`), 'session.json outlives a removal that stopped on a late file')
      assertEquals((await loadSessionIndex(sessions)).byGlb.get('a.glb')?.['sessionId'], S1, 'the link still resolves, so the scan can be deleted again')
    } finally {
      if (stuck) await Deno.chmod(stuck, 0o755).catch(() => undefined)
    }
  })
})

// ── A scan that is still arriving ───────────────────────────────────────────────

Deno.test('a scan being written right now is a user of the sessions its sidecar names, so another scan\'s deletion does not take them', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, S1, { glbFilename: 'A.glb' })
    await makeScan(scans, 'A.glb', { sessionId: S1 })
    // B is mid-upload: its sidecar is in place and its bytes are in a `.part`, not yet renamed to .glb (server/world/scan_store.ts).
    await Deno.writeFile(`${scans}/B.glb.part`, new Uint8Array(64))
    await Deno.writeTextFile(`${scans}/B.json`, JSON.stringify({ sessionId: S1 }))

    const links = await collectScanSessionLinks(scans, await loadSessionIndex(sessions))
    assertEquals(links.get('B.glb'), [S1], 'the scan that is arriving names the session')
    const result = await deleteScanSessions({ scansDir: scans, sessionsDir: sessions, filename: 'A.glb' })
    assertEquals(result.report.deleted, [], 'the session is kept for the scan about to be published')
    assertEquals(result.plan.retained, [{ sessionId: S1, usedBy: ['B.glb'] }])
    assert(await exists(`${sessions}/${S1}`))

    // Once B is published it is an ordinary scan, and deleting it takes the session as the last user.
    await Deno.rename(`${scans}/B.glb.part`, `${scans}/B.glb`)
    const last = await deleteScanSessions({ scansDir: scans, sessionsDir: sessions, filename: 'B.glb' })
    assertEquals(last.plan.retained, [{ sessionId: S1, usedBy: ['A.glb'] }], 'A is still here and still names it')
  })
})

Deno.test('an upload that was cut short long ago names no one\'s sessions, so it cannot keep a session alive for good', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, S1, { glbFilename: 'A.glb' })
    await makeScan(scans, 'A.glb', { sessionId: S1 })
    await Deno.writeFile(`${scans}/B.glb.part`, new Uint8Array(64))
    await Deno.writeTextFile(`${scans}/B.json`, JSON.stringify({ sessionId: S1 }))
    const now = Date.now()
    const old = new Date(now - UNPUBLISHED_UPLOAD_MAX_AGE_MS - 1000)
    await Deno.utime(`${scans}/B.glb.part`, old, old)

    const links = await collectScanSessionLinks(scans, await loadSessionIndex(sessions), now)
    assertEquals(links.has('B.glb'), false, 'a stale .part is not a scan on its way')
    const result = await deleteScanSessions({ scansDir: scans, sessionsDir: sessions, filename: 'A.glb' })
    assertEquals(result.report.deleted, [S1])

    // Just inside the limit it still counts.
    await makeSession(sessions, S2, { glbFilename: 'C.glb' })
    await makeScan(scans, 'C.glb', { sessionId: S2 })
    await Deno.writeFile(`${scans}/D.glb.part`, new Uint8Array(64))
    await Deno.writeTextFile(`${scans}/D.json`, JSON.stringify({ sessionId: S2 }))
    const justInside = new Date(now - UNPUBLISHED_UPLOAD_MAX_AGE_MS + 5000)
    await Deno.utime(`${scans}/D.glb.part`, justInside, justInside)
    assertEquals((await collectScanSessionLinks(scans, await loadSessionIndex(sessions), now)).get('D.glb'), [S2])
  })
})

// ── The frames a walk streamed after its last export ────────────────────────────

Deno.test('a session that follows a scan is the scan\'s too: it goes with it, and another scan\'s followers do not', async () => {
  await withTree(async ({ scans, sessions }) => {
    // The scanner exported `a.glb` (S1, finalized against it), kept walking, and the page ended (S2, no scan of its own).
    await makeSession(sessions, S1, { glbFilename: 'a.glb' })
    await makeSession(sessions, S2, { glbFilename: null as unknown as string, followsGlbFilename: 'a.glb' })
    await makeSession(sessions, S3, { followsGlbFilename: 'b.glb' })
    await makeSession(sessions, S4)
    await makeScan(scans, 'a.glb', { sessionId: S1 })
    await makeScan(scans, 'b.glb', {})
    const index = await loadSessionIndex(sessions)
    assertEquals(sessionIdsLinkedToScan(index, 'a.glb', { sessionId: S1 }).sort(), [S1, S2].sort())
    assertEquals(sessionIdsLinkedToScan(index, 'b.glb', {}), [S3])

    const result = await deleteScanSessions({ scansDir: scans, sessionsDir: sessions, filename: 'a.glb' })
    assertEquals([...result.report.deleted].sort(), [S1, S2].sort())
    assertFalse(await exists(`${sessions}/${S2}`), 'the trailing frames of the walk went with the scan')
    assert(await exists(`${sessions}/${S3}`) && await exists(`${sessions}/${S4}`), 'a session that follows another scan, or none, stays')
  })
})

Deno.test('a following session another scan still names is kept for it, and a follow link does not stand in for glbFilename', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, S1, { followsGlbFilename: 'a.glb' })
    await makeScan(scans, 'a.glb', {})
    // Scan b names the same session in its own sidecar.
    await makeScan(scans, 'b.glb', { sessionId: S1 })
    const result = await deleteScanSessions({ scansDir: scans, sessionsDir: sessions, filename: 'a.glb' })
    assertEquals(result.report.deleted, [])
    assertEquals(result.plan.retained, [{ sessionId: S1, usedBy: ['b.glb'] }])
    // The scan listing resolves a scan through glbFilename alone: a follower must not become any scan's session record there.
    assertEquals((await loadSessionIndex(sessions)).byGlb.has('a.glb'), false)
  })
})
