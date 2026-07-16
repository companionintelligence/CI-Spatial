/**
 * portal_auth.test.ts — unit + integration tests for the Companion Account
 * OIDC flow. Run: deno test --allow-net --allow-env portal_auth.test.ts
 *
 * The integration tests drive the real Hono routes with app.request() and a
 * stub Portal IdP (Deno.serve on a loopback port) that implements just the
 * token + userinfo endpoints, asserting the PKCE/state/allowlist gates.
 */
import { Hono } from 'hono'
import {
  configFromEnv,
  createPkcePair,
  createStateNonce,
  registerPortalAuth,
  safeRelativePath,
  signSession,
  verifySession,
  type PortalAuthConfig,
} from './portal_auth.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEquals<T>(a: T, b: T, msg?: string) {
  if (a !== b) throw new Error(`${msg ?? 'assertEquals'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}

Deno.test('PKCE pair: verifier/challenge are base64url and S256-related', async () => {
  const { verifier, challenge } = await createPkcePair()
  assert(/^[A-Za-z0-9_-]{43}$/.test(verifier), `verifier shape: ${verifier}`)
  assert(/^[A-Za-z0-9_-]{43}$/.test(challenge), `challenge shape: ${challenge}`)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  assertEquals(challenge, expected, 'challenge = b64url(sha256(verifier))')
})

Deno.test('state nonce: 64 hex chars, unique', () => {
  const a = createStateNonce(); const b = createStateNonce()
  assert(/^[0-9a-f]{64}$/.test(a), 'hex shape')
  assert(a !== b, 'unique')
})

Deno.test('session: round-trip, tamper rejection, expiry', async () => {
  const secret = 'test-secret'
  const good = await signSession({ sub: 'u1', email: 'a@b.c', name: 'A', exp: Math.floor(Date.now() / 1000) + 60 }, secret)
  const claims = await verifySession(good, secret)
  assertEquals(claims?.email, 'a@b.c')

  assertEquals(await verifySession(good, 'other-secret'), null, 'wrong key')
  assertEquals(await verifySession(good.slice(0, -2) + 'xx', secret), null, 'tampered sig')
  const [payload] = good.split('.')
  assertEquals(await verifySession(`${payload}x.${good.split('.')[1]}`, secret), null, 'tampered payload')

  const expired = await signSession({ sub: 'u1', email: 'a@b.c', exp: Math.floor(Date.now() / 1000) - 1 }, secret)
  assertEquals(await verifySession(expired, secret), null, 'expired')
})

Deno.test('safeRelativePath blocks open redirects', () => {
  assertEquals(safeRelativePath('/viewer.html?world=x'), '/viewer.html?world=x')
  assertEquals(safeRelativePath('//evil.example'), null)
  assertEquals(safeRelativePath('https://evil.example'), null)
  assertEquals(safeRelativePath('/\\evil'), null)
  assertEquals(safeRelativePath('relative'), null)
  assertEquals(safeRelativePath(null), null)
})

Deno.test('configFromEnv: defaults + fail-closed allowlist', () => {
  const cfg = configFromEnv((k) => ({
    PORTAL_OIDC_ENABLED: '1',
    OIDC_ISSUER_URL: 'https://portal.example/',
  } as Record<string, string>)[k])
  assert(cfg.enabled, 'enabled')
  assertEquals(cfg.issuerUrl, 'https://portal.example', 'trailing slash stripped')
  assertEquals(cfg.clientId, 'ci-web-xr-scan', 'default client id')
  assertEquals(cfg.jwksUri, 'https://portal.example/api/auth/jwks', 'derived jwks')
  assertEquals(cfg.allowedEmails.length, 0, 'empty allowlist = reject everyone')
})

// ── Integration: full callback flow against a stub Portal IdP ────────────────

function stubPortal(opts: { email?: string | null }): { url: string; close: () => Promise<void>; seen: Record<string, unknown> } {
  const seen: Record<string, unknown> = {}
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/api/auth/oauth2/token' && req.method === 'POST') {
      seen.tokenBody = Object.fromEntries(new URLSearchParams(await req.text()))
      return Response.json({ access_token: 'stub-access', token_type: 'Bearer' })
    }
    if (u.pathname === '/api/auth/oauth2/userinfo') {
      seen.userinfoAuth = req.headers.get('authorization')
      return Response.json({ sub: 'portal-user-1', email: opts.email, name: 'Test User' })
    }
    return new Response('not found', { status: 404 })
  })
  const addr = server.addr as Deno.NetAddr
  return { url: `http://127.0.0.1:${addr.port}`, close: () => server.shutdown(), seen }
}

function testApp(issuer: string, allowed: string[]): Hono {
  const cfg: PortalAuthConfig = {
    enabled: true,
    issuerUrl: issuer,
    clientId: 'ci-web-xr-scan',
    publicBaseUrl: 'https://scan.example',
    allowedEmails: allowed,
    jwksUri: `${issuer}/api/auth/jwks`,
    audience: ['ci-web-xr-scan'],
    sessionSecret: 'integration-secret',
    sessionTtlSec: 3600,
  }
  const app = new Hono()
  registerPortalAuth(app, cfg, { ownerDestination: () => Promise.resolve('/viewer.html?world=default&token=owner-tok') })
  return app
}

function cookiesFrom(res: Response): Map<string, string> {
  const jar = new Map<string, string>()
  for (const sc of res.headers.getSetCookie()) {
    const [pair] = sc.split(';')
    const eq = pair.indexOf('=')
    jar.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)))
  }
  return jar
}

Deno.test('initiate: redirects to Portal authorize with PKCE+state, sets handshake cookies', async () => {
  const app = testApp('https://portal.example', ['a@b.c'])
  const res = await app.request('https://scan.example/authenticate/oidc')
  assertEquals(res.status, 302)
  const loc = new URL(res.headers.get('location')!)
  assertEquals(loc.origin + loc.pathname, 'https://portal.example/api/auth/oauth2/authorize')
  assertEquals(loc.searchParams.get('client_id'), 'ci-web-xr-scan')
  assertEquals(loc.searchParams.get('redirect_uri'), 'https://scan.example/authenticate/oidc/callback')
  assertEquals(loc.searchParams.get('code_challenge_method'), 'S256')
  const jar = cookiesFrom(res)
  assert(jar.get('oidc_state') === loc.searchParams.get('state'), 'state cookie matches authorize param')
  assert(jar.has('oidc_pkce'), 'pkce cookie set')
})

Deno.test('callback: happy path exchanges code, enforces allowlist, mints session, redirects to owner link', async () => {
  const portal = stubPortal({ email: 'owner@example.com' })
  try {
    const app = testApp(portal.url, ['owner@example.com'])
    const init = await app.request('https://scan.example/authenticate/oidc')
    const jar = cookiesFrom(init)
    const state = jar.get('oidc_state')!

    const cb = await app.request(
      `https://scan.example/authenticate/oidc/callback?code=authcode1&state=${state}`,
      { headers: { cookie: `oidc_state=${state}; oidc_pkce=${jar.get('oidc_pkce')}` } },
    )
    assertEquals(cb.status, 302, `callback should redirect, got ${cb.status}: ${await cb.text()}`)
    assertEquals(cb.headers.get('location'), '/viewer.html?world=default&token=owner-tok')

    const body = portal.seen.tokenBody as Record<string, string>
    assertEquals(body.grant_type, 'authorization_code')
    assertEquals(body.code, 'authcode1')
    assertEquals(body.client_id, 'ci-web-xr-scan')
    assertEquals(body.code_verifier, jar.get('oidc_pkce'), 'PKCE verifier forwarded')
    assertEquals(portal.seen.userinfoAuth, 'Bearer stub-access')

    const session = cookiesFrom(cb).get('cs_session')
    assert(session, 'session cookie minted')
    const whoami = await app.request('https://scan.example/authenticate/whoami', {
      headers: { cookie: `cs_session=${session}` },
    })
    assertEquals(whoami.status, 200)
    const me = await whoami.json()
    assertEquals(me.email, 'owner@example.com')
    assertEquals(me.via, 'session')
  } finally {
    await portal.close()
  }
})

Deno.test('callback: state mismatch is rejected before any Portal call', async () => {
  const app = testApp('https://portal.invalid', ['a@b.c'])
  const res = await app.request(
    'https://scan.example/authenticate/oidc/callback?code=x&state=forged',
    { headers: { cookie: 'oidc_state=real; oidc_pkce=v' } },
  )
  assertEquals(res.status, 400)
})

Deno.test('callback: allowlist rejects an authenticated but unlisted account', async () => {
  const portal = stubPortal({ email: 'intruder@example.com' })
  try {
    const app = testApp(portal.url, ['owner@example.com'])
    const init = await app.request('https://scan.example/authenticate/oidc')
    const jar = cookiesFrom(init)
    const state = jar.get('oidc_state')!
    const cb = await app.request(
      `https://scan.example/authenticate/oidc/callback?code=c&state=${state}`,
      { headers: { cookie: `oidc_state=${state}; oidc_pkce=${jar.get('oidc_pkce')}` } },
    )
    assertEquals(cb.status, 403)
  } finally {
    await portal.close()
  }
})

Deno.test('whoami without credentials is 401; logout clears the cookie', async () => {
  const app = testApp('https://portal.example', ['a@b.c'])
  const who = await app.request('https://scan.example/authenticate/whoami')
  assertEquals(who.status, 401)
  const out = await app.request('https://scan.example/authenticate/logout', { method: 'POST' })
  assertEquals(out.status, 200)
  assert(out.headers.getSetCookie().some((c) => c.startsWith('cs_session=;')), 'session cleared')
})
