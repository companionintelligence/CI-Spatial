/**
 * scan_index.ts — the session index that makes GET /scans linear.
 *
 * The behaviour being pinned is the *resolution order* of the deleted
 * `readSessionRecordForScan()` in main.ts, which these tests reproduce case by case,
 * plus the read count that was the point of the change: sessions are swept once per
 * listing, not once per scan.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { loadSessionIndex, sessionForScan } from './scan_index.ts'

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'scan-index-' })
  try {
    await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

async function writeSession(
  sessionsDir: string,
  sessionId: string,
  record: Record<string, unknown> | string,
): Promise<void> {
  const dir = `${sessionsDir}/${sessionId}`
  await Deno.mkdir(dir, { recursive: true })
  await Deno.writeTextFile(
    `${dir}/session.json`,
    typeof record === 'string' ? record : JSON.stringify(record),
  )
}

/** Count Deno.readTextFile calls that touch a session.json. */
function countSessionReads(): { count: () => number; restore: () => void } {
  const original = Deno.readTextFile
  let count = 0
  // deno-lint-ignore no-explicit-any
  ;(Deno as any).readTextFile = (path: string | URL, opts?: unknown) => {
    if (String(path).endsWith('session.json')) count += 1
    // deno-lint-ignore no-explicit-any
    return (original as any)(path, opts)
  }
  return {
    count: () => count,
    restore: () => {
      // deno-lint-ignore no-explicit-any
      ;(Deno as any).readTextFile = original
    },
  }
}

Deno.test('loadSessionIndex: one session.json read per session, not per scan', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = `${dir}/sessions`
    const SESSIONS = 50
    const scans: Array<{ filename: string; meta: Record<string, unknown> }> = []

    for (let i = 0; i < SESSIONS; i++) {
      const sessionId = `s${String(i).padStart(3, '0')}`
      await writeSession(sessionsDir, sessionId, {
        sessionId,
        glbFilename: `scan-${i}.glb`,
        keyframeCount: i,
      })
      // 15 of the 50 scans carry an explicit sessionId, as on the real tree.
      scans.push({
        filename: `scan-${i}.glb`,
        meta: i < 15 ? { sessionId } : {},
      })
    }

    const probe = countSessionReads()
    try {
      const index = await loadSessionIndex(sessionsDir)
      for (const scan of scans) {
        await sessionForScan(index, sessionsDir, scan.filename, scan.meta)
      }
      // The old code swept every session directory for every scan without an explicit
      // sessionId: 35 × 50 + 15 = 1,765 reads. One sweep is 50, and every lookup after
      // it is a Map hit.
      assertEquals(probe.count(), SESSIONS, 'exactly one read per session directory')
    } finally {
      probe.restore()
    }

    // ...and every scan still resolved.
    const index = await loadSessionIndex(sessionsDir)
    for (const scan of scans) {
      const record = await sessionForScan(index, sessionsDir, scan.filename, scan.meta)
      assertEquals(record?.['glbFilename'], scan.filename)
    }
  })
})

Deno.test('sessionForScan: an explicit sessionId wins over a glbFilename match', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = `${dir}/sessions`
    // The named session points at a *different* glb, and another session claims ours.
    await writeSession(sessionsDir, 'named', { glbFilename: 'other.glb', tag: 'named' })
    await writeSession(sessionsDir, 'byglb', { glbFilename: 'wanted.glb', tag: 'byglb' })

    const index = await loadSessionIndex(sessionsDir)
    const record = await sessionForScan(index, sessionsDir, 'wanted.glb', { sessionId: 'named' })

    // The old sweep skipped every entry whose name !== explicit, then returned that
    // record because `entry.name === explicit` — the glbFilename mismatch never mattered.
    assertEquals(record?.['tag'], 'named')
  })
})

Deno.test('sessionForScan: an explicit sessionId that misses resolves to null, never by glb', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = `${dir}/sessions`
    await writeSession(sessionsDir, 'byglb', { glbFilename: 'wanted.glb', tag: 'byglb' })

    const index = await loadSessionIndex(sessionsDir)
    const record = await sessionForScan(index, sessionsDir, 'wanted.glb', { sessionId: 'absent' })

    // Must NOT fall through to the glbFilename match: the old sweep had already skipped
    // every other directory, and its fallback loop only tried the explicit id.
    assertEquals(record, null)
  })
})

Deno.test('sessionForScan: explicit sessionId falls back to one direct read when the index missed it', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = `${dir}/sessions`
    await Deno.mkdir(sessionsDir, { recursive: true })

    // An index built before this session existed — the old code's post-sweep fallback
    // loop is what covered this, and it is the path sessionId-carrying scans exercise.
    const index = await loadSessionIndex(sessionsDir)
    await writeSession(sessionsDir, 'late', { glbFilename: 'wanted.glb', tag: 'late' })

    const record = await sessionForScan(index, sessionsDir, 'wanted.glb', { sessionId: 'late' })
    assertEquals(record?.['tag'], 'late')
  })
})

Deno.test('sessionForScan: with no sessionId, the first glbFilename match in readDir order wins', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = `${dir}/sessions`
    await writeSession(sessionsDir, 'a-first', { glbFilename: 'wanted.glb', tag: 'first' })
    await writeSession(sessionsDir, 'b-second', { glbFilename: 'wanted.glb', tag: 'second' })

    const index = await loadSessionIndex(sessionsDir)
    const record = await sessionForScan(index, sessionsDir, 'wanted.glb', {})

    // Whichever readDir yields first must win, exactly as the old early return did.
    const firstInOrder = [...index.bySessionId.keys()][0]
    assertEquals(record?.['tag'], firstInOrder === 'a-first' ? 'first' : 'second')
  })
})

Deno.test('sessionForScan: an explicitly null sessionId resolves through the glbFilename backlink', async () => {
  // Live only since 07-scan-identity/0002. Every sidecar used to carry a
  // client-minted sessionId, so `explicit` was always truthy and this branch
  // was unreachable — which is why setting `glbFilename` alone would have
  // fixed nothing. A scan captured without keyframe streaming now writes
  // `sessionId: null`, and the backlink is what resolves it.
  await withTempDir(async (dir) => {
    const sessionsDir = `${dir}/sessions`
    await writeSession(sessionsDir, 'sess-real', { glbFilename: 'autosaved.glb', tag: 'by-glb' })

    const index = await loadSessionIndex(sessionsDir)
    const record = await sessionForScan(index, sessionsDir, 'autosaved.glb', { sessionId: null })

    assertEquals(record?.['tag'], 'by-glb')
  })
})

Deno.test('sessionForScan: an unmatched scan resolves to null', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = `${dir}/sessions`
    await writeSession(sessionsDir, 's1', { glbFilename: 'something-else.glb' })

    const index = await loadSessionIndex(sessionsDir)
    assertEquals(await sessionForScan(index, sessionsDir, 'wanted.glb', {}), null)
  })
})

Deno.test('loadSessionIndex: an unparseable session.json is swallowed, not fatal', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = `${dir}/sessions`
    await writeSession(sessionsDir, 'broken', '{ not json')
    await writeSession(sessionsDir, 'good', { glbFilename: 'wanted.glb', tag: 'good' })

    const index = await loadSessionIndex(sessionsDir)

    assertEquals(index.bySessionId.has('broken'), false, 'the broken dir is skipped')
    assertEquals(await sessionForScan(index, sessionsDir, 'wanted.glb', {}), { glbFilename: 'wanted.glb', tag: 'good' })
    // An explicit id pointing at the broken record resolves to null, not a throw.
    assertEquals(await sessionForScan(index, sessionsDir, 'wanted.glb', { sessionId: 'broken' }), null)
  })
})

Deno.test('loadSessionIndex: a missing sessions directory is an empty index, not a throw', async () => {
  await withTempDir(async (dir) => {
    const index = await loadSessionIndex(`${dir}/does-not-exist`)
    assertEquals(index.bySessionId.size, 0)
    assertEquals(index.byGlb.size, 0)
    assertEquals(await sessionForScan(index, `${dir}/does-not-exist`, 'any.glb', {}), null)
  })
})

Deno.test('loadSessionIndex: non-directory entries are ignored', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = `${dir}/sessions`
    await Deno.mkdir(sessionsDir, { recursive: true })
    await Deno.writeTextFile(`${sessionsDir}/stray.json`, JSON.stringify({ glbFilename: 'x.glb' }))
    await writeSession(sessionsDir, 's1', { glbFilename: 'wanted.glb' })

    const index = await loadSessionIndex(sessionsDir)
    assertEquals(index.bySessionId.size, 1)
    assertEquals([...index.bySessionId.keys()], ['s1'])
  })
})
