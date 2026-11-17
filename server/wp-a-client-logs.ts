/**
 * POST /client-logs: the rate limit, what one request may write, and the log file.
 *
 * The limiter is keyed on the address of the connection itself, never on a header the client sets.
 * X-Forwarded-For is set by the client, so a limit keyed on it can be bypassed, and a map keyed on
 * it grows with every value a client invents. Keys with no hit inside the window are dropped.
 *
 * What one request may write, and what the log file may hold:
 *   - the body is cut off at CLIENT_LOG_MAX_BODY_BYTES (16 KiB);
 *   - a request carries at most CLIENT_LOG_MAX_ENTRIES entries (env, default 50), and a larger one
 *     is refused with 413;
 *   - msg is kept to 1000 characters, stack to 2000, and the user agent to 256;
 *   - client-logs.jsonl rotates to client-logs.jsonl.1 once it has reached CLIENT_LOGS_MAX_BYTES
 *     (env, default 10 MiB). The previous .1 is replaced, so at most two files are kept.
 */
import { pageUrlWithoutQuery, redactTokens } from './wp-a-log.ts'

/** The body of one POST /client-logs is cut off at this many bytes. */
export const CLIENT_LOG_MAX_BODY_BYTES = 16_384
/** Entries one request may carry when CLIENT_LOG_MAX_ENTRIES is unset. The phone relay buffers 50 per flush. */
export const CLIENT_LOG_DEFAULT_MAX_ENTRIES = 50
/** Longest message kept per entry, in characters. */
export const CLIENT_LOG_MSG_MAX_CHARS = 1000
/** Longest stack trace kept per entry, in characters. */
export const CLIENT_LOG_STACK_MAX_CHARS = 2000
/** Longest user agent kept per record. Every record of a request carries it, so it is capped. */
export const CLIENT_LOG_UA_MAX_CHARS = 256
/** Size at which client-logs.jsonl rotates when CLIENT_LOGS_MAX_BYTES is unset: 10 MiB. */
export const CLIENT_LOGS_DEFAULT_MAX_BYTES = 10 * 1024 * 1024

/** Sliding-window hit counter per key. Expired keys are dropped on every call. */
export class HitLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number

  constructor(limit: number, windowMs: number) {
    this.limit = limit
    this.windowMs = windowMs
  }

  /** Records a hit for `key` at `now`. Returns false, and records nothing, when the key is already at the limit. */
  allow(key: string, now: number): boolean {
    this.prune(now)
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }

  /** Number of keys still tracked. Keys with no hit inside the window are not counted. */
  get size(): number {
    return this.hits.size
  }

  private prune(now: number): void {
    for (const [key, times] of this.hits) {
      if (!times.some((t) => now - t < this.windowMs)) this.hits.delete(key)
    }
  }
}

/**
 * The connecting peer's address, from the connection info Deno.serve passes to the
 * app (Hono keeps it as `c.env`). `'unknown'` when there is none, for example under
 * `app.request()` in a test.
 */
export function remoteAddressOf(env: unknown): string {
  const hostname = (env as { remoteAddr?: { hostname?: unknown } } | null | undefined)?.remoteAddr?.hostname
  return typeof hostname === 'string' && hostname.length > 0 ? hostname : 'unknown'
}

/** One record as it is written to client-logs.jsonl and broadcast on /events. */
export interface ClientLogRecord {
  ts: number
  level: string
  msg: string
  stack: string | undefined
  url: string | undefined
  ua: string | undefined
  ip: string
}

/**
 * The record for one entry of a POST /client-logs body, with the limits above applied.
 *
 * An entry that is not an object reads as empty. Token-like text is blanked before the
 * message and stack are cut, so a credential cannot survive at the cut. The user agent
 * comes from the request, not the entry.
 */
export function clientLogRecord(
  entry: unknown,
  request: { now: number; ua: unknown; ip: string },
): ClientLogRecord {
  const e = (entry !== null && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
  return {
    ts: typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : request.now,
    level: String(e.level ?? 'log'),
    msg: redactTokens(String(e.msg ?? '')).slice(0, CLIENT_LOG_MSG_MAX_CHARS),
    stack: typeof e.stack === 'string' ? redactTokens(e.stack).slice(0, CLIENT_LOG_STACK_MAX_CHARS) : undefined,
    url: pageUrlWithoutQuery(e.url),
    ua: typeof request.ua === 'string' ? request.ua.slice(0, CLIENT_LOG_UA_MAX_CHARS) : undefined,
    ip: request.ip,
  }
}

let clientLogWrites: Promise<void> = Promise.resolve()

/**
 * Appends `text` to the client log at `path`. A file that has reached `maxBytes` is renamed to
 * `<path>.1` first, replacing the previous `.1`, and the text starts a new file. Appends run one
 * at a time in this process, so a rotation cannot race another append.
 */
export function appendClientLog(path: string, text: string, maxBytes: number): Promise<void> {
  const write = clientLogWrites.then(() => appendRotating(path, text, maxBytes))
  clientLogWrites = write.catch(() => undefined)
  return write
}

async function appendRotating(path: string, text: string, maxBytes: number): Promise<void> {
  let size = 0
  try {
    size = (await Deno.stat(path)).size
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
  }
  if (size >= maxBytes) await Deno.rename(path, `${path}.1`)
  await Deno.writeTextFile(path, text, { append: true })
}
