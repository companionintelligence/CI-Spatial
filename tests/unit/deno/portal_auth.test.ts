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
  SHELL_RETURN_URL,
  signSession,
  verifySession,
  type PortalAuthConfig,
} from '../../../server/portal_auth.ts'

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
  // Browsers strip ASCII tab/CR/LF before resolving, turning these into
  // protocol-relative URLs — a pattern-only guard misses them.
  assertEquals(safeRelativePath('/\t/evil.example'), null, 'tab -> protocol-relative')
  assertEquals(safeRelativePath('/\t\\evil.example'), null, 'tab+backslash')
  assertEquals(safeRelativePath('/\r\n/evil.example'), null, 'CRLF')
  assertEquals(safeRelativePath('/ok/path?q=1#frag'), '/ok/path?q=1#frag', 'normal paths survive')
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
  assertEquals(cfg.jwksUri, '', 'discovered unless overridden')
  assertEquals(cfg.allowedEmails.length, 0, 'empty allowlist = reject everyone')
})

// ── Integration: full callback flow against a stub Portal IdP ────────────────

/** The document CI-Portal publishes for an origin. */
function metadataFor(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
    token_endpoint: `${origin}/api/auth/oauth2/token`,
    userinfo_endpoint: `${origin}/api/auth/oauth2/userinfo`,
    jwks_uri: `${origin}/api/auth/jwks`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
  }
}

/** Serves one origin's metadata and nothing else, so a test that needs no Portal never leaves the machine. */
function metadataOnly(origin: string): typeof fetch {
  return ((input: string | URL | Request) => {
    if (String(input) === `${origin}/api/auth/.well-known/openid-configuration`) {
      return Promise.resolve(Response.json(metadataFor(origin)))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }) as unknown as typeof fetch
}

function stubPortal(opts: { email?: string | null; emailVerified?: boolean }): { url: string; close: () => Promise<void>; seen: Record<string, unknown> } {
  const seen: Record<string, unknown> = {}
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/api/auth/oauth2/token' && req.method === 'POST') {
      seen.tokenBody = Object.fromEntries(new URLSearchParams(await req.text()))
      return Response.json({ access_token: 'stub-access', token_type: 'Bearer' })
    }
    if (u.pathname === '/api/auth/.well-known/openid-configuration') return Response.json(metadataFor(u.origin))
    if (u.pathname === '/api/auth/oauth2/userinfo') {
      seen.userinfoAuth = req.headers.get('authorization')
      return Response.json({ sub: 'portal-user-1', email: opts.email, email_verified: opts.emailVerified ?? true, name: 'Test User' })
    }
    return new Response('not found', { status: 404 })
  })
  const addr = server.addr as Deno.NetAddr
  return { url: `http://127.0.0.1:${addr.port}`, close: () => server.shutdown(), seen }
}

function testApp(issuer: string, allowed: string[], portalFetch?: typeof fetch): Hono {
  // The loopback stub Portal serves its own metadata. Any other issuer gets a stub, so no test reaches the network.
  const fetchFn = portalFetch ?? (issuer.startsWith('http://127.0.0.1') ? undefined : metadataOnly(issuer))
  const cfg: PortalAuthConfig = {
    enabled: true,
    issuerUrl: issuer,
    clientId: 'ci-web-xr-scan',
    publicBaseUrl: 'https://scan.example',
    allowedEmails: allowed,
    jwksUri: '',
    audience: ['ci-web-xr-scan'],
    sessionSecret: 'integration-secret',
    sessionTtlSec: 3600,
  }
  const app = new Hono()
  registerPortalAuth(app, cfg, {
    ownerDestination: () => Promise.resolve('/viewer.html?world=default&token=owner-tok'),
    fetch: fetchFn,
  })
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

// ── Regression: authorization gates (verified by adversarial review) ─────────

Deno.test('callback: an unverified email is rejected even when allowlisted', async () => {
  const portal = stubPortal({ email: 'owner@example.com', emailVerified: false })
  try {
    const app = testApp(portal.url, ['owner@example.com'])
    const init = await app.request('https://scan.example/authenticate/oidc')
    const jar = cookiesFrom(init)
    const state = jar.get('oidc_state')!
    const cb = await app.request(
      `https://scan.example/authenticate/oidc/callback?code=c&state=${state}`,
      { headers: { cookie: `oidc_state=${state}; oidc_pkce=${jar.get('oidc_pkce')}` } },
    )
    assertEquals(cb.status, 403, 'unverified email must not authorize')
    assert(!cookiesFrom(cb).get('cs_session'), 'no session is minted')
  } finally {
    await portal.close()
  }
})

Deno.test('whoami: a valid Portal JWT for a non-allowlisted account is refused', async () => {
  // The Bearer branch previously returned 200 for any structurally valid token,
  // bypassing PORTAL_OIDC_ALLOWED_EMAILS entirely.
  const app = testApp('https://portal.example', ['owner@example.com'])
  const res = await app.request('https://scan.example/authenticate/whoami', {
    headers: { authorization: 'Bearer not-a-real-jwt' },
  })
  assert(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`)
})

Deno.test('cookie: a malformed percent-escape degrades to 401, never a 500', async () => {
  const app = testApp('https://portal.example', ['a@b.c'])
  const res = await app.request('https://scan.example/authenticate/whoami', {
    headers: { cookie: 'cs_session=%' },
  })
  assertEquals(res.status, 401, 'malformed cookie must not throw')
})

Deno.test('session: non-ASCII claims survive the round-trip', async () => {
  const secret = 'utf8-secret'
  const token = await signSession(
    { sub: 'u1', email: 'jose@example.com', name: 'José Ámundsen 日本', exp: Math.floor(Date.now() / 1000) + 60 },
    secret,
  )
  const claims = await verifySession(token, secret)
  assertEquals(claims?.name, 'José Ámundsen 日本', 'UTF-8 must not be mangled to latin-1')
})

Deno.test('status: reports whether sign-in is on, as a boolean and nothing else', async () => {
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ['stock install', {}, false],
    ['switch on, issuer set', { PORTAL_OIDC_ENABLED: '1', OIDC_ISSUER_URL: 'https://portal.example' }, true],
    ['switch on, no issuer', { PORTAL_OIDC_ENABLED: 'true' }, false],
    ['issuer set, switch off', { OIDC_ISSUER_URL: 'https://portal.example' }, false],
  ]
  for (const [name, vars, want] of cases) {
    const cfg = configFromEnv((k) => vars[k])
    const app = new Hono()
    registerPortalAuth(app, cfg, { ownerDestination: () => Promise.resolve('/') })
    const res = await app.request('https://scan.example/authenticate/status')
    assertEquals(res.status, 200, `${name}: the status route is always registered`)
    const body = await res.json() as Record<string, unknown>
    assertEquals(body['enabled'], want, name)
    // Boolean only: the issuer, client id and allowlist must never reach a browser from here.
    assertEquals(Object.keys(body).join(','), 'enabled', `${name}: no other field`)
  }
})

Deno.test('status: on a stock install nothing else in the sign-in flow is registered', async () => {
  const app = new Hono()
  registerPortalAuth(app, configFromEnv(() => undefined), { ownerDestination: () => Promise.resolve('/') })
  assertEquals((await app.request('https://scan.example/authenticate/oidc')).status, 404, 'initiate')
  assertEquals((await app.request('https://scan.example/authenticate/whoami')).status, 404, 'whoami')
})

/** Runs the Portal leg of a shell sign-in and returns the app-scheme URL the callback redirected to. */
async function shellCallback(app: Hono, challenge: string): Promise<string> {
  const init = await app.request(`https://scan.example/authenticate/oidc?shell=1&challenge=${challenge}`)
  const jar = cookiesFrom(init)
  const state = jar.get('oidc_state')!
  const cb = await app.request(
    `https://scan.example/authenticate/oidc/callback?code=shell-authcode&state=${state}`,
    { headers: { cookie: `oidc_state=${state}; oidc_pkce=${jar.get('oidc_pkce')}; oidc_shell=${challenge}` } },
  )
  assertEquals(cb.status, 302, `shell callback should redirect, got ${cb.status}: ${await cb.text()}`)
  assertEquals(cookiesFrom(cb).has('cs_session'), false, 'the shell gets no session cookie')
  return cb.headers.get('location')!
}

async function exchange(app: Hono, code: string, verifier: string): Promise<Response> {
  return await app.request('https://scan.example/authenticate/shell/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier }),
  })
}

Deno.test('shell: initiate refuses a challenge that is not PKCE-shaped, before any Portal redirect', async () => {
  const app = testApp('https://portal.example', ['a@b.c'])
  const res = await app.request('https://scan.example/authenticate/oidc?shell=1&challenge=too-short')
  assertEquals(res.status, 400)
  assertEquals(res.headers.get('location'), null, 'no redirect to the Portal')
})

Deno.test('shell: the callback ends in the app scheme, and the code trades for a Bearer token once', async () => {
  const portal = stubPortal({ email: 'owner@example.com' })
  try {
    const app = testApp(portal.url, ['owner@example.com'])
    const { verifier, challenge } = await createPkcePair()
    const loc = await shellCallback(app, challenge)
    assert(loc.startsWith(`${SHELL_RETURN_URL}?code=`), `app-scheme return, got ${loc}`)
    const code = new URL(loc).searchParams.get('code')!

    const first = await exchange(app, code, verifier)
    assertEquals(first.status, 200)
    assertEquals(first.headers.get('cache-control'), 'no-store')
    const body = await first.json() as { token: string; email: string; name: string | null }
    assertEquals(body.email, 'owner@example.com')
    assertEquals(body.name, 'Test User')

    const who = await app.request('https://scan.example/authenticate/whoami', {
      headers: { authorization: `Bearer ${body.token}` },
    })
    assertEquals(who.status, 200)
    const me = await who.json() as Record<string, unknown>
    assertEquals(me['email'], 'owner@example.com')
    assertEquals(me['via'], 'shell-token')

    assertEquals((await exchange(app, code, verifier)).status, 400, 'the code is single use')
  } finally {
    await portal.close()
  }
})

Deno.test('shell: a wrong verifier fails, and it uses the code up so the right one cannot retry', async () => {
  const portal = stubPortal({ email: 'owner@example.com' })
  try {
    const app = testApp(portal.url, ['owner@example.com'])
    const { verifier, challenge } = await createPkcePair()
    const code = new URL(await shellCallback(app, challenge)).searchParams.get('code')!
    const other = await createPkcePair()
    assertEquals((await exchange(app, code, other.verifier)).status, 400, 'verifier must match the challenge')
    assertEquals((await exchange(app, code, verifier)).status, 400, 'the code is spent by the failed attempt')
  } finally {
    await portal.close()
  }
})

Deno.test('shell: a malformed exchange body is refused without touching the code store', async () => {
  const app = testApp('https://portal.example', ['a@b.c'])
  const bad = [
    { code: 'x' },
    { code: '', verifier: 'a'.repeat(43) },
    { code: 'x', verifier: 'short' },
  ]
  for (const body of bad) {
    const res = await app.request('https://scan.example/authenticate/shell/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assertEquals(res.status, 400, JSON.stringify(body))
  }
  const notJson = await app.request('https://scan.example/authenticate/shell/exchange', { method: 'POST', body: '{' })
  assertEquals(notJson.status, 400)
})

Deno.test('shell cookie: a web sign-in after a shell one still ends at the owner link, not the app', async () => {
  const portal = stubPortal({ email: 'owner@example.com' })
  try {
    const app = testApp(portal.url, ['owner@example.com'])
    const init = await app.request('https://scan.example/authenticate/oidc')
    assert(init.headers.getSetCookie().some((c) => c.startsWith('oidc_shell=;')), 'a web initiate clears the shell cookie')
    const jar = cookiesFrom(init)
    const state = jar.get('oidc_state')!
    const cb = await app.request(
      `https://scan.example/authenticate/oidc/callback?code=c&state=${state}`,
      { headers: { cookie: `oidc_state=${state}; oidc_pkce=${jar.get('oidc_pkce')}` } },
    )
    assertEquals(cb.headers.get('location'), '/viewer.html?world=default&token=owner-tok')
  } finally {
    await portal.close()
  }
})

Deno.test('shell token: a token for an account since removed from the allowlist is refused', async () => {
  const app = testApp('https://portal.example', ['still@example.com'])
  const token = await signSession(
    { sub: 'u2', email: 'removed@example.com', exp: Math.floor(Date.now() / 1000) + 60 },
    'integration-secret',
  )
  const res = await app.request('https://scan.example/authenticate/whoami', {
    headers: { authorization: `Bearer ${token}` },
  })
  assertEquals(res.status, 403)
})

Deno.test('shell token: a forged or tampered Bearer is 401, never a session', async () => {
  const app = testApp('https://portal.example', ['a@b.c'])
  const forged = await signSession(
    { sub: 'u3', email: 'a@b.c', exp: Math.floor(Date.now() / 1000) + 60 },
    'some-other-secret',
  )
  const res = await app.request('https://scan.example/authenticate/whoami', {
    headers: { authorization: `Bearer ${forged}` },
  })
  assertEquals(res.status, 401)
})
