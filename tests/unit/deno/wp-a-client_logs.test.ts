/**
 * POST /client-logs (server/wp-a-client-logs.ts): the rate limiter keyed on the connection's
 * address, the limits on each record, and the rotating log file.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  appendClientLog,
  CLIENT_LOG_DEFAULT_MAX_ENTRIES,
  CLIENT_LOG_MAX_BODY_BYTES,
  CLIENT_LOG_MSG_MAX_CHARS,
  CLIENT_LOG_STACK_MAX_CHARS,
  CLIENT_LOG_UA_MAX_CHARS,
  CLIENT_LOGS_DEFAULT_MAX_BYTES,
  clientLogRecord,
  HitLimiter,
  remoteAddressOf,
} from '../../../server/wp-a-client-logs.ts'

Deno.test('a key is admitted up to its limit inside the window, then refused', () => {
  const limiter = new HitLimiter(2, 1000)
  assertEquals(limiter.allow('10.0.0.5', 0), true)
  assertEquals(limiter.allow('10.0.0.5', 1), true)
  assertEquals(limiter.allow('10.0.0.5', 2), false, 'third hit inside the window')
})

Deno.test('the window slides: an old hit stops counting', () => {
  const limiter = new HitLimiter(2, 1000)
  limiter.allow('k', 0)
  limiter.allow('k', 1)
  assertEquals(limiter.allow('k', 1001), true, 'both earlier hits have aged out')
})

Deno.test('one key at its limit does not block another key', () => {
  const limiter = new HitLimiter(1, 1000)
  assertEquals(limiter.allow('a', 0), true)
  assertEquals(limiter.allow('a', 1), false)
  assertEquals(limiter.allow('b', 1), true)
})

Deno.test('keys with no hit inside the window are pruned on the next call', () => {
  const limiter = new HitLimiter(60, 60_000)
  limiter.allow('gone-1', 0)
  limiter.allow('gone-2', 1_000)
  assertEquals(limiter.size, 2)
  limiter.allow('fresh', 61_000)
  assertEquals(limiter.size, 1, 'only the fresh key remains')
})

Deno.test('a flood of distinct keys does not keep growing the map once they expire', () => {
  const limiter = new HitLimiter(60, 60_000)
  for (let i = 0; i < 5_000; i++) limiter.allow(`spoof-${i}`, 0)
  assertEquals(limiter.size, 5_000)
  limiter.allow('next', 60_000)
  assertEquals(limiter.size, 1)
})

Deno.test('remoteAddressOf reads the peer address from Deno.serve connection info', () => {
  assertEquals(
    remoteAddressOf({ remoteAddr: { transport: 'tcp', hostname: '100.64.0.7', port: 51234 } }),
    '100.64.0.7',
  )
})

Deno.test('remoteAddressOf answers unknown when there is no connection info', () => {
  assertEquals(remoteAddressOf(undefined), 'unknown')
  assertEquals(remoteAddressOf(null), 'unknown')
  assertEquals(remoteAddressOf({}), 'unknown')
  assertEquals(remoteAddressOf({ remoteAddr: { hostname: '' } }), 'unknown')
})

const REQUEST = { now: 1000, ua: undefined, ip: '7' }

Deno.test('the documented limits are the values the route enforces', () => {
  assertEquals(CLIENT_LOG_DEFAULT_MAX_ENTRIES, 50, 'the phone relay buffers 50 entries per flush')
  assertEquals(CLIENT_LOG_MAX_BODY_BYTES, 16_384)
  assertEquals(CLIENT_LOG_MSG_MAX_CHARS, 1000)
  assertEquals(CLIENT_LOG_STACK_MAX_CHARS, 2000)
  assertEquals(CLIENT_LOG_UA_MAX_CHARS, 256)
  assertEquals(CLIENT_LOGS_DEFAULT_MAX_BYTES, 10 * 1024 * 1024)
})

Deno.test('a message is kept to 1000 characters and a stack trace to 2000', () => {
  const record = clientLogRecord({ msg: 'm'.repeat(5000), stack: 's'.repeat(5000) }, REQUEST)
  assertEquals(record.msg.length, CLIENT_LOG_MSG_MAX_CHARS)
  assertEquals(record.stack?.length, CLIENT_LOG_STACK_MAX_CHARS)
})

Deno.test('the user agent is kept to 256 characters on every record, and a non-text one is dropped', () => {
  const ua = 'u'.repeat(4000)
  assertEquals(clientLogRecord({ msg: 'a' }, { now: 1, ua, ip: '7' }).ua?.length, CLIENT_LOG_UA_MAX_CHARS)
  assertEquals(clientLogRecord({ msg: 'b' }, { now: 1, ua: { big: 'object' }, ip: '7' }).ua, undefined)
})

Deno.test('token-like parameters are blanked before the cut, so a credential cannot survive it', () => {
  const record = clientLogRecord(
    { msg: 'open ?token=SECRET123 now', stack: 'at f (x?access_token=ABC123)' },
    REQUEST,
  )
  assert(!record.msg.includes('SECRET123'), 'the message keeps no token')
  assert(!record.stack?.includes('ABC123'), 'the stack keeps no token')
})

Deno.test('the page URL is kept without its query or fragment', () => {
  assertEquals(clientLogRecord({ url: '/scanner.html?token=abc#x' }, REQUEST).url, '/scanner.html')
  assertEquals(clientLogRecord({}, REQUEST).url, undefined)
})

Deno.test('an entry that is not an object reads as empty, stamped with the request time', () => {
  for (const entry of [null, 'text', 7, []]) {
    const record = clientLogRecord(entry, REQUEST)
    assertEquals(record.ts, 1000)
    assertEquals(record.level, 'log')
    assertEquals(record.msg, '')
    assertEquals(record.ip, '7')
  }
})

Deno.test('a finite timestamp is kept, and anything else takes the request time', () => {
  assertEquals(clientLogRecord({ ts: 5 }, REQUEST).ts, 5)
  assertEquals(clientLogRecord({ ts: '5' }, REQUEST).ts, 1000)
})

Deno.test('a log file at the size limit rotates to .1 before the next append, and .1 is replaced', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'wp-a-client-logs-' })
  try {
    const file = `${dir}/client-logs.jsonl`
    const first = 'x'.repeat(100) + '\n'
    await appendClientLog(file, first, 50)
    assertEquals(await Deno.readTextFile(file), first, 'an absent file is created')

    await appendClientLog(file, 'second\n', 50)
    assertEquals(await Deno.readTextFile(`${file}.1`), first, 'the full file moved to .1')
    assertEquals(await Deno.readTextFile(file), 'second\n')

    await appendClientLog(file, 'third\n', 50)
    await appendClientLog(file, 'y'.repeat(60) + '\n', 50)
    assertEquals(await Deno.readTextFile(file), 'second\nthird\n' + 'y'.repeat(60) + '\n', 'under the limit: no rotation')

    await appendClientLog(file, 'fourth\n', 50)
    assertEquals(await Deno.readTextFile(`${file}.1`), 'second\nthird\n' + 'y'.repeat(60) + '\n', 'the previous .1 is replaced')
    assertEquals(await Deno.readTextFile(file), 'fourth\n')

    const names: string[] = []
    for await (const entry of Deno.readDir(dir)) names.push(entry.name)
    assertEquals(names.sort(), ['client-logs.jsonl', 'client-logs.jsonl.1'], 'at most two files are kept')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('concurrent appends are written one after another, so none is lost to a rotation', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'wp-a-client-logs-' })
  try {
    const file = `${dir}/client-logs.jsonl`
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendClientLog(file, `line-${i}\n`, 1_000_000)))
    const lines = (await Deno.readTextFile(file)).split('\n').filter(Boolean)
    assertEquals(lines.length, 20)
    assertEquals(new Set(lines).size, 20, 'every line is there once')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
