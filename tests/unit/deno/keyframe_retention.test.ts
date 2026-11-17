/**
 * Keyframe retention (server/keyframe_retention.ts): the setting, and the purge that enforces it, against real
 * temporary directories.
 *
 * What these hold: an unset or mistyped setting keeps everything; a session is old by its last sign of life and
 * not by when it began; a session a scan is made from is never purged; only a real session folder directly
 * under the sessions folder is touched, and only when that folder is inside the scans folder; a dry run
 * counts and removes nothing; what a pass says about itself is counts, with no id and no path in it; and a request is
 * a dry run unless it says, with the boolean false, that it is not (and then it takes the server's own period).
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import {
  KEYFRAME_PURGE_INTERVAL_MS,
  KEYFRAME_RETENTION_ENV,
  keyframePurgeFailure,
  parseKeyframeRetentionDays,
  purgeExpiredKeyframeSessions,
  purgeRequestFromPayload,
  purgeSummary,
  runKeyframePurge,
  scheduleKeyframeRetention,
} from '../../../server/keyframe_retention.ts'
import { cannotRemoveFromReadOnlyFolder } from './read_only_folders.ts'

/** Root can remove from a read-only folder, so a test that makes its failure that way is ignored there, not passed. */
const CAN_MAKE_A_PERMISSION_FAILURE = await cannotRemoveFromReadOnlyFolder()

const DAY = 24 * 60 * 60 * 1000
/** A fixed clock, so no test depends on when it runs. */
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0)

const OLD = 'sess-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MID = 'sess-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NEW = 'sess-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const UPLOAD = 'sess-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PERSON = 'sess-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const BARE = 'sess-ffffffff-ffff-4fff-8fff-ffffffffffff'

interface Tree {
  root: string
  scans: string
  sessions: string
}

async function withTree(run: (tree: Tree) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: 'keyframe-retention-' })
  const scans = `${root}/scans`
  const sessions = `${scans}/sessions`
  await Deno.mkdir(sessions, { recursive: true })
  try {
    await run({ root, scans, sessions })
  } finally {
    await restoreWritable(root)
    await Deno.remove(root, { recursive: true }).catch(() => undefined)
  }
}

async function restoreWritable(dir: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isDirectory) continue
      await Deno.chmod(`${dir}/${entry.name}`, 0o755).catch(() => undefined)
      await restoreWritable(`${dir}/${entry.name}`)
    }
  } catch { /* gone */ }
}

interface SessionSpec {
  /** Days before NOW that the session began and was last written to. */
  ageDays: number
  /** Days before NOW of the last frame, when it is later than the session began. */
  lastFrameDays?: number
  source?: string
  captureKind?: string
  /** No session.json, as a crash between mkdir and the record leaves it. */
  noRecord?: boolean
}

/** A session whose files carry the age the spec gives them: the record's dates and the files' own modification times. */
async function makeSession(sessions: string, id: string, spec: SessionSpec): Promise<string> {
  const dir = `${sessions}/${id}`
  await Deno.mkdir(dir, { recursive: true })
  const startedAt = new Date(NOW - spec.ageDays * DAY)
  await Deno.writeFile(`${dir}/kf-00000.jpg`, new Uint8Array(2000))
  await Deno.writeTextFile(`${dir}/keyframes.jsonl`, '{"index":0,"file":"kf-00000.jpg"}\n')
  const written = new Date(NOW - (spec.lastFrameDays ?? spec.ageDays) * DAY)
  if (!spec.noRecord) {
    const record: Record<string, unknown> = { sessionId: id, startedAt: startedAt.toISOString(), keyframeCount: 1 }
    if (spec.source) record['source'] = spec.source
    if (spec.captureKind) record['captureKind'] = spec.captureKind
    await Deno.writeTextFile(`${dir}/session.json`, JSON.stringify(record))
    await Deno.utime(`${dir}/session.json`, startedAt, startedAt)
  }
  await Deno.utime(`${dir}/kf-00000.jpg`, written, written)
  await Deno.utime(`${dir}/keyframes.jsonl`, written, written)
  await Deno.utime(dir, written, written)
  return dir
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path)
    return true
  } catch {
    return false
  }
}

// ── The setting ─────────────────────────────────────────────────────────────────

Deno.test('the setting keeps everything unless it is a number of days', () => {
  for (const raw of [undefined, null, '', '   ', 'off', 'OFF', 'keep', ' Keep ']) {
    assertEquals(parseKeyframeRetentionDays(raw), { days: null, problem: null }, `${JSON.stringify(raw)} keeps everything, with nothing to say`)
  }
  assertEquals(parseKeyframeRetentionDays('90'), { days: 90, problem: null })
  assertEquals(parseKeyframeRetentionDays(' 30 '), { days: 30, problem: null })
  assertEquals(parseKeyframeRetentionDays('1').days, 1)
  assertEquals(parseKeyframeRetentionDays('36500').days, 36500)
})

Deno.test('a mistyped setting keeps everything and says why, so a typo never deletes', () => {
  for (const raw of ['-5', '1.5', 'ninety', '30d', '0x10', '36501', '1e3', '--days', '+7']) {
    const setting = parseKeyframeRetentionDays(raw)
    assertEquals(setting.days, null, `${raw} deletes nothing`)
    assert(setting.problem !== null && setting.problem.includes(KEYFRAME_RETENTION_ENV), `${raw} says which setting is wrong`)
  }
})

Deno.test('0 keeps everything and says it is not accepted, because it could mean "no limit" or "keep none"', () => {
  for (const raw of ['0', ' 0 ', '00']) {
    const setting = parseKeyframeRetentionDays(raw)
    assertEquals(setting.days, null, `${JSON.stringify(raw)} deletes nothing`)
    assert(setting.problem !== null && setting.problem.includes('0 is not accepted'), `${JSON.stringify(raw)} says why: ${setting.problem}`)
    assertStringIncludes(setting.problem!, 'unset to keep everything')
  }
})

Deno.test('the purge is queued once a day', () => {
  assertEquals(KEYFRAME_PURGE_INTERVAL_MS, 24 * 60 * 60 * 1000)
})

// ── The purge ───────────────────────────────────────────────────────────────────

Deno.test('a session is purged when its last activity is older than the period, and kept when it is not', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, OLD, { ageDays: 100 })
    await makeSession(sessions, MID, { ageDays: 10 })
    await makeSession(sessions, NEW, { ageDays: 0 })
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: 30, dryRun: false, now: NOW })
    assertEquals(report.skipped, null)
    assertEquals([report.scanned, report.expired, report.deleted, report.keptYoung, report.keptSource, report.failed], [3, 1, 1, 2, 0, 0])
    assert(report.bytes >= 2000, `the bytes it freed: ${report.bytes}`)
    assertFalse(await exists(`${sessions}/${OLD}`), 'the old session is gone')
    assert(await exists(`${sessions}/${MID}`))
    assert(await exists(`${sessions}/${NEW}`))
  })
})

Deno.test('the boundary: a session is expired at exactly the period and kept a moment before it', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, OLD, { ageDays: 30 })
    await makeSession(sessions, MID, { ageDays: 29.99 })
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: 30, dryRun: true, now: NOW })
    assertEquals([report.expired, report.keptYoung], [1, 1])
  })
})

Deno.test('a session that began long ago but was written to recently is not old', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, OLD, { ageDays: 200, lastFrameDays: 2 })
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: 30, dryRun: false, now: NOW })
    assertEquals([report.expired, report.deleted, report.keptYoung], [0, 0, 1])
    assert(await exists(`${sessions}/${OLD}`))
  })
})

Deno.test('a session that is a scan\'s own source is never purged, however old', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, UPLOAD, { ageDays: 400, source: 'photo-ingest' })
    await makeSession(sessions, PERSON, { ageDays: 400, captureKind: 'person' })
    await makeSession(sessions, OLD, { ageDays: 400 })
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: 1, dryRun: false, now: NOW })
    assertEquals([report.scanned, report.keptSource, report.deleted], [3, 2, 1])
    assert(await exists(`${sessions}/${UPLOAD}`))
    assert(await exists(`${sessions}/${PERSON}`))
    assertFalse(await exists(`${sessions}/${OLD}`))
  })
})

Deno.test('a dry run counts what would go and removes nothing', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, OLD, { ageDays: 100 })
    await makeSession(sessions, MID, { ageDays: 90 })
    await makeSession(sessions, NEW, { ageDays: 1 })
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: 30, dryRun: true, now: NOW })
    assertEquals([report.dryRun, report.expired, report.deleted, report.failed], [true, 2, 0, 0])
    assert(report.bytes >= 4000, `it measured what a real pass would free: ${report.bytes}`)
    for (const id of [OLD, MID, NEW]) assert(await exists(`${sessions}/${id}`), `${id} is still there`)
    // The same pass with the dry run off then removes exactly what the dry run said it would.
    const real = await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: 30, dryRun: false, now: NOW })
    assertEquals([real.expired, real.deleted, real.bytes], [report.expired, report.expired, report.bytes])
  })
})

Deno.test('with no retention period nothing is examined or removed', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, OLD, { ageDays: 4000 })
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: null, dryRun: false, now: NOW })
    assertEquals([report.skipped, report.scanned, report.deleted], ['retention-off', 0, 0])
    assert(await exists(`${sessions}/${OLD}`))
  })
})

Deno.test('a sessions folder outside the scans folder is never purged', async () => {
  await withTree(async ({ root, scans }) => {
    const elsewhere = `${root}/elsewhere/sessions`
    await Deno.mkdir(elsewhere, { recursive: true })
    await makeSession(elsewhere, OLD, { ageDays: 400 })
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: elsewhere, scansDir: scans, retentionDays: 1, dryRun: false, now: NOW })
    assertEquals([report.skipped, report.scanned, report.deleted], ['sessions-outside-scans', 0, 0])
    assert(await exists(`${elsewhere}/${OLD}`), 'what is outside the scans folder is left alone')
    assertStringIncludes(purgeSummary(report), 'nothing was deleted')
  })
})

Deno.test('a sessions folder that is a link out of the scans folder is refused too', async () => {
  await withTree(async ({ root, scans }) => {
    const elsewhere = `${root}/elsewhere`
    await Deno.mkdir(elsewhere, { recursive: true })
    await makeSession(elsewhere, OLD, { ageDays: 400 })
    await Deno.remove(`${scans}/sessions`, { recursive: true })
    await Deno.symlink(elsewhere, `${scans}/sessions`)
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: `${scans}/sessions`, scansDir: scans, retentionDays: 1, dryRun: false, now: NOW })
    assertEquals(report.skipped, 'sessions-outside-scans', 'the real path is what is checked, not the name')
    assert(await exists(`${elsewhere}/${OLD}`))
  })
})

Deno.test('a missing sessions folder is a skipped pass, not a failure', async () => {
  await withTree(async ({ scans }) => {
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: `${scans}/no-such-folder`, scansDir: scans, retentionDays: 1, dryRun: false, now: NOW })
    assertEquals(report.skipped, 'sessions-dir-missing')
  })
})

Deno.test('only a real session folder is examined: not a link, a file, or another folder', async () => {
  await withTree(async ({ root, scans, sessions }) => {
    const target = `${root}/outside`
    await Deno.mkdir(target, { recursive: true })
    await Deno.writeTextFile(`${target}/session.json`, JSON.stringify({ startedAt: '2001-01-01T00:00:00Z' }))
    await Deno.writeTextFile(`${target}/precious.txt`, 'precious')
    await Deno.symlink(target, `${sessions}/${OLD}`)
    await Deno.mkdir(`${sessions}/not-a-session`, { recursive: true })
    await Deno.writeTextFile(`${sessions}/${MID}`, 'a file named like a session')
    await Deno.mkdir(`${scans}/projects/proj-1`, { recursive: true })
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: 1, dryRun: false, now: NOW })
    assertEquals([report.scanned, report.deleted], [0, 0])
    assert(await exists(`${target}/precious.txt`))
    assert((await Deno.lstat(`${sessions}/${OLD}`)).isSymlink)
    assert(await exists(`${sessions}/not-a-session`))
    assert(await exists(`${sessions}/${MID}`))
    assert(await exists(`${scans}/projects/proj-1`), 'nothing outside the sessions folder is looked at')
  })
})

Deno.test('a session left with no record is judged by its files', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, BARE, { ageDays: 90, noRecord: true })
    await makeSession(sessions, NEW, { ageDays: 0, noRecord: true })
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: 30, dryRun: false, now: NOW })
    assertEquals([report.deleted, report.keptYoung], [1, 1])
    assertFalse(await exists(`${sessions}/${BARE}`))
    assert(await exists(`${sessions}/${NEW}`))
  })
})

Deno.test({
  name: 'a session that cannot be removed is counted as failed and the pass goes on',
  ignore: !CAN_MAKE_A_PERMISSION_FAILURE,
}, async () => {
  await withTree(async ({ scans, sessions }) => {
    const stuck = await makeSession(sessions, OLD, { ageDays: 100 })
    await Deno.mkdir(`${stuck}/work`)
    await Deno.writeTextFile(`${stuck}/work/out.bin`, 'x')
    await Deno.chmod(`${stuck}/work`, 0o555)
    await makeSession(sessions, MID, { ageDays: 100 })
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: 30, dryRun: false, now: NOW })
    assertEquals([report.expired, report.deleted, report.failed], [2, 1, 1])
    assert(await exists(`${stuck}/session.json`), 'the failed session keeps its record, so the next pass finds it')
    assertFalse(await exists(`${sessions}/${MID}`))
  })
})

Deno.test('what a pass says is counts, and names no session, no path and no place', async () => {
  await withTree(async ({ root, scans, sessions }) => {
    await makeSession(sessions, OLD, { ageDays: 100 })
    await makeSession(sessions, UPLOAD, { ageDays: 100, source: 'video-ingest' })
    await makeSession(sessions, NEW, { ageDays: 0 })
    for (const dryRun of [true, false]) {
      const report = await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: 30, dryRun, now: NOW })
      const line = purgeSummary(report)
      assert(/etention 30 days/.test(line), line)
      assertStringIncludes(line, dryRun ? 'Dry run' : 'deleted 1 of 3')
      for (const secret of [OLD, UPLOAD, NEW, root, scans, sessions, 'sess-']) {
        assertFalse(line.includes(secret), `the summary names ${secret}`)
      }
      assertFalse(/[\\/]/.test(line), 'no path separator')
    }
    assertStringIncludes(purgeSummary({ ...(await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: null, dryRun: false, now: NOW })) }), 'Retention is off')
  })
})

/** Runs `work` with console.log, warn and error recorded, and puts them back. */
async function recordingConsole<T>(work: () => Promise<T> | T): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const saved = { log: console.log, warn: console.warn, error: console.error }
  const record = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  console.log = record
  console.warn = record
  console.error = record
  try {
    return { result: await work(), lines }
  } finally {
    console.log = saved.log
    console.warn = saved.warn
    console.error = saved.error
  }
}

Deno.test('the job\'s pass reads the period from the environment, purges, logs counts, and returns the line it reports', async () => {
  await withTree(async ({ root, scans, sessions }) => {
    await makeSession(sessions, OLD, { ageDays: 100 })
    await makeSession(sessions, NEW, { ageDays: 0 })
    const env = (name: string) => (name === KEYFRAME_RETENTION_ENV ? '30' : undefined)
    const { result, lines } = await recordingConsole(() => runKeyframePurge({ sessionsDir: sessions, scansDir: scans, env, dryRun: false }))
    assertStringIncludes(result, 'deleted 1 of 2')
    assertEquals(lines.length, 1)
    assertStringIncludes(lines[0]!, '[keyframe-retention]')
    for (const secret of [OLD, NEW, root, 'kf-00000']) assertFalse(lines[0]!.includes(secret), `the log names ${secret}`)
    assertFalse(await exists(`${sessions}/${OLD}`))

    // With the period unset the same call keeps everything and says so.
    await makeSession(sessions, BARE, { ageDays: 4000 })
    const off = await recordingConsole(() => runKeyframePurge({ sessionsDir: sessions, scansDir: scans, env: () => undefined, dryRun: false }))
    assertStringIncludes(off.result, 'Retention is off')
    assert(await exists(`${sessions}/${BARE}`))
  })
})

Deno.test('a failed pass is reported by the error\'s name alone, in the job and in the log', async () => {
  const { result, lines } = await recordingConsole(() => keyframePurgeFailure(new Deno.errors.PermissionDenied('open \'/home/someone/scans/sessions/sess-secret\'')))
  assertEquals(result, 'The purge stopped on an error (PermissionDenied).')
  assertEquals(lines, ['[keyframe-retention] the purge stopped on an error (PermissionDenied)'])
  assertEquals((await recordingConsole(() => keyframePurgeFailure('not an Error'))).result, 'The purge stopped on an error (Error).')
})

Deno.test('a retention period queues a purge now and once a day; no period, or a typo, queues nothing', async () => {
  let queued = 0
  const queue = () => {
    queued += 1
    return Promise.resolve()
  }
  const set = await recordingConsole(() => scheduleKeyframeRetention('90', queue))
  assertEquals(queued, 1, 'a purge is queued as the server boots')
  assertStringIncludes(set.lines.join('\n'), 'kept 90 days')
  set.result()

  for (const raw of [undefined, '', 'off', 'keep']) {
    const stop = scheduleKeyframeRetention(raw, queue)
    stop()
  }
  assertEquals(queued, 1, 'unset keeps everything and schedules nothing')

  const zero = await recordingConsole(() => scheduleKeyframeRetention('0', queue))
  zero.result()
  assertEquals(queued, 1, '0 schedules nothing')
  assertStringIncludes(zero.lines.join('\n'), '0 is not accepted')

  const typo = await recordingConsole(() => scheduleKeyframeRetention('ninety', queue))
  typo.result()
  assertEquals(queued, 1, 'a typo schedules nothing')
  assertStringIncludes(typo.lines.join('\n'), 'KEYFRAME_RETENTION_DAYS must be a whole number of days')
})

Deno.test('a purge that cannot be queued is logged by the error\'s name and does not stop the server', async () => {
  const { result: stop, lines } = await recordingConsole(() => scheduleKeyframeRetention('30', () => Promise.reject(new Deno.errors.NotFound('/secret/path'))))
  await new Promise((resolve) => setTimeout(resolve, 10))
  stop()
  assertStringIncludes(lines.join('\n'), 'could not queue a purge (NotFound)')
  assertFalse(lines.join('\n').includes('/secret'), 'the message, which can hold a path, is not logged')
})

// ── What a request may ask ──────────────────────────────────────────────────────

Deno.test('a request is a dry run unless its payload says dryRun is the boolean false', () => {
  for (const payload of [undefined, null, {}, { dryRun: true }, { dryRun: 'false' }, { dryRun: 'true' }, { dryRun: 0 }, { dryRun: 1 }, { dryRun: null }, { dryRun: 'no' }, { dryRun: [] }, { days: 30 }]) {
    assertEquals(purgeRequestFromPayload(payload as Record<string, unknown> | undefined).dryRun, true, `${JSON.stringify(payload)} only reports`)
  }
  assertEquals(purgeRequestFromPayload({ dryRun: false }).dryRun, false, 'only the boolean false removes anything')
})

Deno.test('a period in a request is read for a dry run only, and only when it is a whole number of days in range', () => {
  assertEquals(purgeRequestFromPayload({ dryRun: true, days: 30 }).previewDays, 30)
  assertEquals(purgeRequestFromPayload({ days: 365 }).previewDays, 365, 'a request with no dryRun is a dry run, so it may preview')
  assertEquals(purgeRequestFromPayload({ dryRun: false, days: 1 }).previewDays, null, 'a real pass never takes a period from a request')
  for (const days of [0, -5, 1.5, 36501, '30', null, NaN, Infinity, {}, [], true]) {
    assertEquals(purgeRequestFromPayload({ dryRun: true, days }).previewDays, null, `${JSON.stringify(days)} is not a period`)
  }
  assertEquals(purgeRequestFromPayload({ dryRun: true, days: 36500 }).previewDays, 36500)
})

Deno.test('a dry run can judge by a period the request names, a real pass cannot, and the report says which is the server\'s own', async () => {
  await withTree(async ({ scans, sessions }) => {
    await makeSession(sessions, OLD, { ageDays: 100 })
    await makeSession(sessions, MID, { ageDays: 40 })
    await makeSession(sessions, NEW, { ageDays: 3 })
    const env = (setting: string | undefined) => (name: string) => (name === KEYFRAME_RETENTION_ENV ? setting : undefined)
    const run = (setting: string | undefined, dryRun: boolean, previewDays: number | null) =>
      recordingConsole(() => runKeyframePurge({ sessionsDir: sessions, scansDir: scans, env: env(setting), dryRun, previewDays })).then((out) => out.result)

    // Setting off: a dry run can still show what a period would remove, and says nothing is purged until it is set.
    const preview = await run(undefined, true, 30)
    assertStringIncludes(preview, 'Dry run, retention 30 days: 2 of 3')
    assertStringIncludes(preview, 'The server\'s own setting is off')
    assertStringIncludes(preview, 'KEYFRAME_RETENTION_DAYS')
    // A different period from the server's own says what the server's own is.
    const other = await run('60', true, 10)
    assertStringIncludes(other, 'Dry run, retention 10 days: 2 of 3')
    assertStringIncludes(other, 'The server\'s own setting is 60 days')
    // The server's own period, previewed or not, says nothing extra.
    assertFalse((await run('30', true, 30)).includes('own setting'))
    assertFalse((await run('30', true, null)).includes('own setting'))
    for (const id of [OLD, MID, NEW]) assert(await exists(`${sessions}/${id}`), `${id}: a dry run removed nothing`)

    // A real pass ignores a preview period, even one a caller passed: it judges by the setting, or does nothing when it is off.
    assertStringIncludes(await run(undefined, false, 1), 'Retention is off')
    assert(await exists(`${sessions}/${NEW}`))
    assertStringIncludes(await run('60', false, 1), 'deleted 1 of 3')
    assertFalse(await exists(`${sessions}/${OLD}`))
    assert(await exists(`${sessions}/${MID}`) && await exists(`${sessions}/${NEW}`), 'judged by 60 days, not the 1 that was passed')
  })
})

Deno.test('a dry run with the setting off says how to preview a period, and a real pass with it off does not', () => {
  const off = {
    dryRun: true,
    retentionDays: null,
    settingDays: null,
    skipped: 'retention-off' as const,
    scanned: 0,
    expired: 0,
    deleted: 0,
    keptSource: 0,
    keptYoung: 0,
    failed: 0,
    bytes: 0,
  }
  assertStringIncludes(purgeSummary(off), '"dryRun": true, "days": 30')
  assertFalse(purgeSummary({ ...off, dryRun: false }).includes('days'))
})

Deno.test('a session is judged by when it was streamed or finalized, and what a job wrote in it later does not keep it', async () => {
  await withTree(async ({ scans, sessions }) => {
    const dir = await makeSession(sessions, OLD, { ageDays: 100 })
    // A reconstruction job wrote poses into it today. The purge removes what a job wrote in the folder with the frames, so this
    // is old for what the purge keeps it for: the frames.
    await Deno.writeTextFile(`${dir}/lingbot-map.poses.json`, '[]')
    const report = await purgeExpiredKeyframeSessions({ sessionsDir: sessions, scansDir: scans, retentionDays: 30, dryRun: false, now: NOW })
    assertEquals([report.expired, report.deleted], [1, 1])
    assertFalse(await exists(dir))
  })
})
