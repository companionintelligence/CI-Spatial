/**
 * origin_allowlist.test.ts — which browser origins may call the Scan. The CORS middleware and the
 * WebSocket upgrade both ask, so a wrong answer lets a page in, or keeps the app's own page out.
 * Runs with the rest of the unit suite: deno task test
 */
import {
  DESKTOP_SHELL_ORIGINS,
  isAllowedOrigin,
  isNativeShellOrigin,
  NATIVE_SHELL_ORIGIN,
  originOf,
  type OriginAllowlist,
} from '../../../server/origin.ts'

function assertEquals<T>(a: T, b: T, msg?: string) {
  if (a !== b) throw new Error(`${msg ?? 'assertEquals'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}

const PUBLIC = 'https://scan.example.com'
const allowlist: OriginAllowlist = { prefix: 'https://scan.example.test', publicOrigin: PUBLIC }

Deno.test('the native shell origin is allowed', () => {
  assertEquals(isAllowedOrigin(NATIVE_SHELL_ORIGIN, allowlist), true, 'capacitor')
})

Deno.test('the desktop shell origins are allowed, on every platform', () => {
  // macOS and Linux serve the Tauri bundle from tauri://localhost; Windows from http://tauri.localhost,
  // or https://tauri.localhost with useHttpsScheme.
  assertEquals(DESKTOP_SHELL_ORIGINS.length, 3, 'three origins')
  for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']) {
    assertEquals(DESKTOP_SHELL_ORIGINS.includes(origin), true, `listed: ${origin}`)
    assertEquals(isAllowedOrigin(origin, allowlist), true, origin)
    assertEquals(isAllowedOrigin(origin, { prefix: 'https://other.example.test', publicOrigin: null }), true, `${origin}, whatever the prefix`)
  }
})

Deno.test('only the exact desktop origins are allowed, as with the iOS one', () => {
  assertEquals(isAllowedOrigin('tauri://evil.example', allowlist), false, 'another tauri host')
  assertEquals(isAllowedOrigin('tauri://localhost:8080', allowlist), false, 'a tauri port')
  assertEquals(isAllowedOrigin('http://tauri.localhost:8080', allowlist), false, 'a port on the Windows origin')
  assertEquals(isAllowedOrigin('https://tauri.localhost.evil.example', allowlist), false, 'a longer host')
  assertEquals(isAllowedOrigin('http://evil.tauri.localhost', allowlist), false, 'a deeper subdomain')
  assertEquals(isAllowedOrigin('capacitor://evil.example', allowlist), false, 'another capacitor host')
})

Deno.test('a shell origin is the app on the device, not an address to share', () => {
  for (const origin of [NATIVE_SHELL_ORIGIN, 'https://localhost', ...DESKTOP_SHELL_ORIGINS]) {
    assertEquals(isNativeShellOrigin(origin), true, origin)
  }
  for (const origin of [PUBLIC, 'http://localhost:5173', 'https://localhost:5173', 'https://phone.tailnet.ts.net']) {
    assertEquals(isNativeShellOrigin(origin), false, origin)
  }
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
