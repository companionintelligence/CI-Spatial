/**
 * origin_allowlist.test.ts — which browser origins may call the Scan. The CORS middleware and the
 * WebSocket upgrade both ask, so a wrong answer lets a page in, or keeps the app's own page out.
 * Runs with the rest of the unit suite: deno task test
 */
import { isAllowedOrigin, NATIVE_SHELL_ORIGIN, originOf, type OriginAllowlist } from '../../../server/origin.ts'

function assertEquals<T>(a: T, b: T, msg?: string) {
  if (a !== b) throw new Error(`${msg ?? 'assertEquals'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}

const PUBLIC = 'https://scan.example.com'
const allowlist: OriginAllowlist = { prefix: 'https://scan.example.test', publicOrigin: PUBLIC }

Deno.test('the native shell origin is allowed', () => {
  assertEquals(isAllowedOrigin(NATIVE_SHELL_ORIGIN, allowlist), true, 'capacitor')
})

Deno.test("the app's own public origin is allowed", () => {
  assertEquals(isAllowedOrigin(PUBLIC, allowlist), true, 'public')
})

Deno.test('the public origin is refused when no public address is configured', () => {
  assertEquals(isAllowedOrigin(PUBLIC, { ...allowlist, publicOrigin: null }), false, 'no public address')
})

Deno.test('another scheme or host on the public name is refused', () => {
  assertEquals(isAllowedOrigin('http://scan.example.com', allowlist), false, 'http')
  assertEquals(isAllowedOrigin('https://evil.example.com', allowlist), false, 'other host')
})

Deno.test('the prefix admits its own port, not a longer host name', () => {
  assertEquals(isAllowedOrigin('https://scan.example.test:8443', allowlist), true, 'port')
  assertEquals(isAllowedOrigin('https://scan.example.test.evil.example', allowlist), false, 'longer host')
  assertEquals(isAllowedOrigin('https://scan.example.testing', allowlist), false, 'longer label')
})

Deno.test('a public host name with an attacker suffix is refused', () => {
  assertEquals(isAllowedOrigin('https://scan.example.com.evil.example', allowlist), false, 'suffix')
})

Deno.test('localhost, the tailnet and private networks are allowed', () => {
  assertEquals(isAllowedOrigin('http://localhost:5173', allowlist), true, 'localhost')
  assertEquals(isAllowedOrigin('https://phone.tailnet.ts.net', allowlist), true, 'ts.net')
  assertEquals(isAllowedOrigin('http://192.168.1.20:8000', allowlist), true, 'lan')
  assertEquals(isAllowedOrigin('https://203.0.113.9', allowlist), false, 'public address')
})

Deno.test('originOf reads the origin of a configured address, or null', () => {
  assertEquals(originOf('https://scan.example.com/'), 'https://scan.example.com', 'origin')
  assertEquals(originOf(null), null, 'missing')
  assertEquals(originOf('not a url'), null, 'invalid')
})
