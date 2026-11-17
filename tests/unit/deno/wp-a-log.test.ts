/**
 * The request log never writes a query string (server/wp-a-log.ts). Tokens travel in
 * `?token=`, and a logged query is a logged credential.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { Hono } from 'hono'
import { pageUrlWithoutQuery, redactedRequestLogger, redactTokens, stripQueryFromLogLine } from '../../../server/wp-a-log.ts'

Deno.test('stripQueryFromLogLine drops the query and keeps the method, path and status', () => {
  assertEquals(stripQueryFromLogLine('<-- GET /events?token=abc123'), '<-- GET /events')
  assertEquals(
    stripQueryFromLogLine('--> GET /worlds/x/?token=abc123&role=owner 200 3ms'),
    '--> GET /worlds/x/ 200 3ms',
  )
  assertEquals(stripQueryFromLogLine('<-- GET /health'), '<-- GET /health', 'no query, no change')
})

Deno.test('the formatted request log has no query string and no token', async () => {
  const lines: string[] = []
  const app = new Hono()
  app.use(redactedRequestLogger((line) => lines.push(line)))
  app.get('/events', (c) => c.text('ok'))

  const res = await app.request('/events?token=SECRET-OWNER-TOKEN&ua=probe')
  assertEquals(res.status, 200)

  assertEquals(lines.length, 2, `expected an incoming and an outgoing line, got ${JSON.stringify(lines)}`)
  for (const line of lines) {
    assert(!line.includes('?'), `query string in: ${line}`)
    assert(!line.includes('SECRET'), `token in: ${line}`)
    assert(line.includes('/events'), `path missing from: ${line}`)
  }
})

Deno.test('a client-reported page URL is kept without its query or fragment', () => {
  assertEquals(pageUrlWithoutQuery('https://scan.test:5173/editor?world=default&token=SECRET-VIEWER#x'), 'https://scan.test:5173/editor')
  assertEquals(pageUrlWithoutQuery('/scanner.html'), '/scanner.html', 'no query, no change')
  assertEquals(pageUrlWithoutQuery(undefined), undefined, 'missing')
  assertEquals(pageUrlWithoutQuery(42), undefined, 'not text')
})

Deno.test('token-like parameters pasted into a client message or stack are blanked', () => {
  const msg = 'fetch failed: https://scan.test/worlds/x?token=SECRET-ABC&role=viewer'
  const redacted = redactTokens(msg)
  assertEquals(redacted, 'fetch failed: https://scan.test/worlds/x?token=[redacted]&role=viewer')
  assert(!redacted.includes('SECRET'), redacted)
  assertEquals(redactTokens('at load (https://scan.test/app.js#access_token=SECRET-XYZ)'), 'at load (https://scan.test/app.js#access_token=[redacted])')
  assertEquals(redactTokens('plain message, nothing secret'), 'plain message, nothing secret')
})
