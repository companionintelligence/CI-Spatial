/**
 * origin_allowlist.test.ts — which browser origins may call the Scan. The CORS middleware, the
 * WebSocket upgrade and the file routes all ask, so a wrong answer lets a page in, or keeps the app's
 * own page out. Runs with the rest of the unit suite: deno task test
 */
import {
  DESKTOP_SHELL_ORIGINS,
  isAllowedOrigin,
  isNativeShellOrigin,
  NATIVE_SHELL_ORIGIN,
  originOf,
  originResponseHeaders,
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

// Localhost and private networks are admitted only in dev mode (ALLOW_DEV_ORIGINS=1). The tailnet name is
// admitted only when it is configured.
Deno.test('localhost and private networks are refused outside dev', () => {
  assertEquals(isAllowedOrigin('http://localhost:5173', allowlist), false, 'localhost')
  assertEquals(isAllowedOrigin('http://192.168.1.20:8000', allowlist), false, 'lan')
  assertEquals(isAllowedOrigin('https://203.0.113.9', allowlist), false, 'public address')
})

// Every Tailscale tailnet shares the .ts.net suffix, so a name is admitted only when it is configured
// (TAILSCALE_HOSTNAME or ALLOWED_ORIGIN_PREFIX), never by the suffix alone.
Deno.test('another tailnet name is refused unless it is configured', () => {
  assertEquals(isAllowedOrigin('https://phone.tailnet.ts.net', allowlist), false, 'other tailnet')
  assertEquals(isAllowedOrigin('https://phone.tailnet.ts.net:5173', allowlist), false, 'other tailnet, port')
})

Deno.test('the configured tailnet host is admitted on the port the web app uses', () => {
  const tailnet: OriginAllowlist = {
    prefix: 'https://phone.tailnet.ts.net',
    tailnetOrigin: 'https://phone.tailnet.ts.net',
    publicOrigin: null,
  }
  assertEquals(isAllowedOrigin('https://phone.tailnet.ts.net:5173', tailnet), true, 'phone on the web port')
  assertEquals(isAllowedOrigin('https://phone.tailnet.ts.net', tailnet), true, 'bare host')
  assertEquals(isAllowedOrigin('https://phone.tailnet.ts.net.evil.example', tailnet), false, 'lookalike host')
  assertEquals(isAllowedOrigin('https://other.tailnet.ts.net', tailnet), false, 'other host on the suffix')
})

Deno.test('TAILSCALE_HOSTNAME is admitted even when ALLOWED_ORIGIN_PREFIX names another origin', () => {
  const split: OriginAllowlist = {
    prefix: 'https://scan.example.test',
    tailnetOrigin: 'https://box.tailnet.ts.net',
    publicOrigin: null,
  }
  assertEquals(isAllowedOrigin('https://box.tailnet.ts.net:5173', split), true, 'hostname')
  assertEquals(isAllowedOrigin('https://scan.example.test:5173', split), true, 'prefix')
})

Deno.test('both native shells are admitted: capacitor, and the Android https://localhost', () => {
  assertEquals(isAllowedOrigin('capacitor://localhost', allowlist), true, 'ios shell')
  assertEquals(isAllowedOrigin('https://localhost', allowlist), true, 'android shell')
  assertEquals(isAllowedOrigin('http://localhost', allowlist), false, 'plain http localhost is dev only')
})

Deno.test('dev origins admit localhost and private networks, not public or .ts.net names', () => {
  const dev: OriginAllowlist = { ...allowlist, devOrigins: true }
  assertEquals(isAllowedOrigin('http://localhost:5173', dev), true, 'localhost')
  assertEquals(isAllowedOrigin('http://127.0.0.1:8000', dev), true, 'loopback')
  assertEquals(isAllowedOrigin('http://192.168.1.20:8000', dev), true, 'lan')
  assertEquals(isAllowedOrigin('http://10.0.0.5:8000', dev), true, '10/8')
  assertEquals(isAllowedOrigin('http://172.20.1.1:8000', dev), true, '172.16/12')
  assertEquals(isAllowedOrigin('http://100.100.1.1:8000', dev), true, 'shared address space')
  assertEquals(isAllowedOrigin('https://203.0.113.9', dev), false, 'public address')
  assertEquals(isAllowedOrigin('https://phone.tailnet.ts.net', dev), false, 'an unconfigured .ts.net name')
})

Deno.test('originResponseHeaders echoes an allowed origin, never a wildcard', () => {
  const allowed = originResponseHeaders('https://scan.example.test:5173', allowlist)
  assertEquals(allowed['Access-Control-Allow-Origin'], 'https://scan.example.test:5173', 'echo')
  assertEquals(allowed['Vary'], 'Origin', 'vary')
  assertEquals(Object.values(allowed).includes('*'), false, 'never a wildcard')
})

Deno.test('originResponseHeaders sends no allow-origin for a refused or missing origin', () => {
  assertEquals(originResponseHeaders('https://evil.example', allowlist)['Access-Control-Allow-Origin'], undefined, 'refused')
  assertEquals(originResponseHeaders(undefined, allowlist)['Access-Control-Allow-Origin'], undefined, 'missing')
  assertEquals(originResponseHeaders(undefined, allowlist)['Vary'], 'Origin', 'vary still set')
})

Deno.test('originResponseHeaders sends no allow-origin for a .ts.net origin that is not listed', () => {
  assertEquals(
    originResponseHeaders('https://phone.tailnet.ts.net', allowlist)['Access-Control-Allow-Origin'],
    undefined,
    'an unlisted tailnet name',
  )
  assertEquals(
    originResponseHeaders('https://phone.tailnet.ts.net:5173', allowlist)['Access-Control-Allow-Origin'],
    undefined,
    'an unlisted tailnet name on a port',
  )
})

Deno.test('originOf reads the origin of a configured address, or null', () => {
  assertEquals(originOf('https://scan.example.com/'), 'https://scan.example.com', 'origin')
  assertEquals(originOf(null), null, 'missing')
  assertEquals(originOf('not a url'), null, 'invalid')
})
