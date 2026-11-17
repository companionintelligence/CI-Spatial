/**
 * The byte budget for one capture session's keyframes (POST /sessions/:id/keyframes).
 *
 * The per-frame cap and the frame-count cap do not bound a session's disk use together: a session
 * can take its full frame count at the per-frame cap. The budget is the sum of the frame files
 * already in the session directory, read before each write, so the route can refuse the write that
 * would take the session past it.
 *
 * A repeated index overwrites its frame file, because a retry depends on that. It is not counted
 * twice: the bytes of the file it replaces do not count against the budget.
 *
 * Writes are queued per session (`writeKeyframe`). Without the queue, two overlapping POSTs for one
 * session could both read the budget before either wrote, and both append a line for one index.
 */
import { withWorldLock } from './world/world_lock.ts'

/** A session may hold this many bytes of keyframes when KEYFRAME_SESSION_MAX_BYTES is unset: 2 GiB. */
export const KEYFRAME_SESSION_DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024

/** Size in bytes of each keyframe file in `dir` whose name matches `fileName`, keyed by name. A missing directory is empty. */
export async function keyframeSizesIn(dir: string, fileName: RegExp): Promise<Map<string, number>> {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && fileName.test(entry.name)) names.push(entry.name)
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return new Map()
    throw err
  }
  const sizes = new Map<string, number>()
  await Promise.all(names.map(async (name) => {
    try {
      sizes.set(name, (await Deno.stat(`${dir}/${name}`)).size)
    } catch {
      // Removed between the listing and the stat: it no longer counts.
    }
  }))
  return sizes
}

/**
 * Whether writing `incomingBytes` under `name` would take the session past `maxBytes`. The file
 * already under `name`, if there is one, is replaced by the write, so its bytes do not count.
 */
export function overKeyframeBudget(
  sizes: ReadonlyMap<string, number>,
  name: string,
  incomingBytes: number,
  maxBytes: number,
): boolean {
  let total = 0
  for (const [file, bytes] of sizes) {
    if (file !== name) total += bytes
  }
  return total + incomingBytes > maxBytes
}

/**
 * Whether keyframes.jsonl already holds a meta record for `name`. A missing file holds none.
 *
 * Finalize counts the lines of this file, so a repeated index must not add a second one. A
 * record with the same name counts as the one line for that frame.
 */
export async function keyframeRecorded(jsonlPath: string, name: string): Promise<boolean> {
  let text: string
  try {
    text = await Deno.readTextFile(jsonlPath)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false
    throw err
  }
  return text.split('\n').some((line) => {
    if (line.trim() === '') return false
    try {
      return (JSON.parse(line) as { file?: unknown } | null)?.file === name
    } catch {
      return false
    }
  })
}

/** One frame to write into a session: its file name, its bytes and the meta record the client sent. */
export interface KeyframeWrite {
  /** The frame's file name, `kf-NNNNN.jpg`. */
  name: string
  bytes: Uint8Array
  meta: Record<string, unknown>
  /** The session's byte budget. */
  maxBytes: number
  /** Matches the file names in the session that are keyframe files. */
  fileName: RegExp
}

/**
 * Runs `critical` after every keyframe write queued before it for `sessionDir` has settled. Other
 * sessions do not wait on it, and a section that throws does not hold up the ones behind it.
 *
 * This is `withWorldLock` (server/world/world_lock.ts), the server's per-key promise queue, the same
 * chain `mutateProjects` keeps for the Places registry, keyed here per session. The key is prefixed so
 * that it cannot meet a world slug.
 */
export function queueKeyframeWrite<T>(sessionDir: string, critical: () => Promise<T>): Promise<T> {
  return withWorldLock(`keyframes:${sessionDir}`, critical)
}

/**
 * Writes one keyframe into a session and records its line in keyframes.jsonl. Resolves
 * `'over-budget'`, and writes nothing, when the write would take the session past its budget.
 * The check and the write run inside `queueKeyframeWrite`, so each one sees every write before it
 * for the same session.
 */
export function writeKeyframe(sessionDir: string, frame: KeyframeWrite): Promise<'written' | 'over-budget'> {
  return queueKeyframeWrite(sessionDir, async () => {
    const sizes = await keyframeSizesIn(sessionDir, frame.fileName)
    if (overKeyframeBudget(sizes, frame.name, frame.bytes.byteLength, frame.maxBytes)) return 'over-budget'
    await Deno.writeFile(`${sessionDir}/${frame.name}`, frame.bytes)
    // A repeated index (a retry) overwrites its frame. It adds no second line when the first one is
    // recorded, because finalize counts the lines of keyframes.jsonl.
    const repeated = sizes.has(frame.name)
    if (!repeated || !(await keyframeRecorded(`${sessionDir}/keyframes.jsonl`, frame.name))) {
      await Deno.writeTextFile(
        `${sessionDir}/keyframes.jsonl`,
        JSON.stringify({ ...frame.meta, file: frame.name, bytes: frame.bytes.byteLength, receivedAt: Date.now() }) + '\n',
        { append: true },
      )
    }
    return 'written'
  })
}

/**
 * The number of lines in keyframes.jsonl, read through the session's queue (`queueKeyframeWrite`), so
 * the read runs after every keyframe write queued before it has settled. A write already queued before
 * the count is counted whole; one queued after it is left out. A missing or unreadable file counts 0.
 */
export function countKeyframeLines(sessionDir: string): Promise<number> {
  return queueKeyframeWrite(sessionDir, async () => {
    try {
      const jsonl = await Deno.readTextFile(sessionDir + '/keyframes.jsonl')
      return jsonl.split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  })
}
