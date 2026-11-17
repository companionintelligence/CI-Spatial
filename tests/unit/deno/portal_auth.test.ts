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
  DESKTOP_RETURN_URL,
  safeRelativePath,
  SHELL_RETURN_URL,
  shellReturnFor,
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

/**
 * Runs the Portal leg of a shell sign-in and returns the app-scheme URL the callback redirected to.
 * `shell` is what the app sends: `1` from the phone app, `desktop` from the desktop app.
 */
async function shellCallback(app: Hono, challenge: string, shell: '1' | 'desktop' = '1'): Promise<string> {
  const init = await app.request(`https://scan.example/authenticate/oidc?shell=${shell}&challenge=${challenge}`)
  const jar = cookiesFrom(init)
  const state = jar.get('oidc_state')!
  const appMark = jar.get('oidc_shell_app') ? `; oidc_shell_app=${jar.get('oidc_shell_app')}` : ''
  const cb = await app.request(
    `https://scan.example/authenticate/oidc/callback?code=shell-authcode&state=${state}`,
    { headers: { cookie: `oidc_state=${state}; oidc_pkce=${jar.get('oidc_pkce')}; oidc_shell=${challenge}${appMark}` } },
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

Deno.test('desktop: the callback ends in the desktop app scheme, and the code trades for a Bearer token once', async () => {
  const portal = stubPortal({ email: 'owner@example.com' })
  try {
    const app = testApp(portal.url, ['owner@example.com'])
    const { verifier, challenge } = await createPkcePair()
    const loc = await shellCallback(app, challenge, 'desktop')
    assert(loc.startsWith(`${DESKTOP_RETURN_URL}?code=`), `desktop-scheme return, got ${loc}`)
    assert(!loc.startsWith(SHELL_RETURN_URL), 'not the phone app')
    const code = new URL(loc).searchParams.get('code')!

    const first = await exchange(app, code, verifier)
    assertEquals(first.status, 200)
    const body = await first.json() as { token: string; email: string }
    assertEquals(body.email, 'owner@example.com')
    const who = await app.request('https://scan.example/authenticate/whoami', {
      headers: { authorization: `Bearer ${body.token}` },
    })
    assertEquals(who.status, 200)
    assertEquals((await who.json() as Record<string, unknown>)['via'], 'shell-token')
    assertEquals((await exchange(app, code, verifier)).status, 400, 'the code is single use')
  } finally {
    await portal.close()
  }
})

Deno.test('desktop: initiate marks the desktop app, and a phone or web initiate clears the mark', async () => {
  const app = testApp('https://portal.example', ['a@b.c'])
  const challenge = 'C'.repeat(43)
  const desktop = cookiesFrom(await app.request(`https://scan.example/authenticate/oidc?shell=desktop&challenge=${challenge}`))
  assertEquals(desktop.get('oidc_shell_app'), 'desktop')
  assertEquals(desktop.get('oidc_shell'), challenge)
  const phone = cookiesFrom(await app.request(`https://scan.example/authenticate/oidc?shell=1&challenge=${challenge}`))
  assertEquals(phone.get('oidc_shell_app'), '', 'the phone app clears it')
  assertEquals(phone.get('oidc_shell'), challenge)
  const web = cookiesFrom(await app.request('https://scan.example/authenticate/oidc'))
  assertEquals(web.get('oidc_shell_app'), '', 'a web sign-in clears it')
  assertEquals(web.get('oidc_shell'), '')
  const refused = await app.request('https://scan.example/authenticate/oidc?shell=desktop&challenge=too-short')
  assertEquals(refused.status, 400, 'the desktop app needs a PKCE challenge too')
})

Deno.test('shellReturnFor: only shell=1 and shell=desktop start a shell sign-in, each to its own fixed scheme', () => {
  assertEquals(shellReturnFor('1'), SHELL_RETURN_URL)
  assertEquals(shellReturnFor('desktop'), DESKTOP_RETURN_URL)
  for (const other of [undefined, '', '0', 'true', 'Desktop', 'https://evil.example', 'computer.ci.scan.desktop://auth']) {
    assertEquals(shellReturnFor(other), null, String(other))
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
    assert(init.headers.getSetCookie().some((c) => c.startsWith('oidc_shell_app=;')), 'and the desktop app mark')
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

// ── POST /authenticate/shell/exchange is open before sign-in, so it is bounded ───────────────────
//
// It is the one route a stranger can POST a body to on a public Scan, so its body is capped and its
// callers are rate limited (server/wp-a-body.ts readTextCapped, server/wp-a-client-logs.ts HitLimiter,
// as POST /client-logs does). The numbers below are the contract: the body is a code and a verifier,
// about 110 bytes, and a sign-in makes one request.

/** The most bytes one exchange body may carry. */
const EXCHANGE_MAX_BODY_BYTES = 4096
/** The most exchanges one address may make in a minute. */
const EXCHANGE_MAX_PER_MINUTE = 60
const EXCHANGE_URL = 'https://scan.example/authenticate/shell/exchange'

/** A POST to the exchange route, as a Request, so a test can hand it a stream and say what it declares. */
function exchangePost(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(EXCHANGE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    duplex: 'half',
  } as RequestInit)
}

/** A body that yields `chunks` as they are asked for, counting how many were. Nothing is pulled until something reads. */
function countedStream(chunks: Uint8Array[]): { body: ReadableStream<Uint8Array>; pulled: () => number } {
  let next = 0
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < chunks.length) controller.enqueue(chunks[next++])
        else controller.close()
      },
    }, { highWaterMark: 0 }),
    pulled: () => next,
  }
}

/** `text` followed by enough spaces to make it exactly `bytes` bytes long. Trailing whitespace is still valid JSON. */
function paddedTo(text: string, bytes: number): string {
  const used = new TextEncoder().encode(text).length
  assert(used <= bytes, `${used} bytes do not fit in ${bytes}`)
  return text + ' '.repeat(bytes - used)
}

const NOT_CONFIRMED = 'Sign-in could not be confirmed. Start again.'
const EXPIRED = 'Sign-in expired. Start again.'

Deno.test('shell exchange: the cap is on the body, so a valid exchange at it works, one byte over is refused, and the refusal spends nothing', async () => {
  const portal = stubPortal({ email: 'owner@example.com' })
  try {
    const app = testApp(portal.url, ['owner@example.com'])
    const { verifier, challenge } = await createPkcePair()
    const code = new URL(await shellCallback(app, challenge)).searchParams.get('code')!
    const exchangeBody = JSON.stringify({ code, verifier })

    // Valid JSON for a live code, over the cap only by its trailing spaces. If anything parsed it, it would be honoured.
    const over = await app.request(exchangePost(paddedTo(exchangeBody, EXCHANGE_MAX_BODY_BYTES + 1)))
    assertEquals(over.status, 413, 'one byte over the cap')
    assert(typeof (await over.json() as { error?: unknown }).error === 'string', 'the refusal says why')
    const far = await app.request(exchangePost(paddedTo(exchangeBody, 8 * EXCHANGE_MAX_BODY_BYTES)))
    assertEquals(far.status, 413, 'far over the cap')
    await far.body?.cancel()

    // The code was never read, so it is still good, and a body exactly at the cap is read and honoured as before.
    const at = await app.request(exchangePost(paddedTo(exchangeBody, EXCHANGE_MAX_BODY_BYTES)))
    assertEquals(at.status, 200, 'exactly at the cap')
    assertEquals(at.headers.get('cache-control'), 'no-store')
    const session = await at.json() as { token: string; email: string; name: string | null }
    assertEquals(session.email, 'owner@example.com')
    assertEquals(session.name, 'Test User')
    assert(await verifySession(session.token, 'integration-secret'), 'the token is the shell session')
  } finally {
    await portal.close()
  }
})

Deno.test('shell exchange: a length declared over the cap is refused without reading a byte', async () => {
  const app = testApp('https://portal.example', ['a@b.c'])
  const { body, pulled } = countedStream([new Uint8Array(10)])
  const res = await app.request(exchangePost(body, { 'content-length': String(EXCHANGE_MAX_BODY_BYTES + 1) }))
  assertEquals(res.status, 413)
  assertEquals(pulled(), 0, 'the body was not read')
})

Deno.test('shell exchange: a chunked body with no declared length is cut off at the cap, not buffered whole', async () => {
  const app = testApp('https://portal.example', ['a@b.c'])
  // 1 MiB of spaces in 1 KiB chunks. Nothing here would parse as an exchange, but nothing should be asked to.
  const { body, pulled } = countedStream(Array.from({ length: 1024 }, () => new Uint8Array(1024).fill(0x20)))
  const res = await app.request(exchangePost(body))
  assertEquals(res.status, 413)
  const allowedChunks = EXCHANGE_MAX_BODY_BYTES / 1024 + 2
  assert(pulled() <= allowedChunks, `read ${pulled()} of 1024 chunks, more than the ${allowedChunks} the cap allows`)
})

Deno.test('shell exchange: a body that cannot be parsed or names no code gets the answers it always did', async () => {
  const portal = stubPortal({ email: 'owner@example.com' })
  try {
    const app = testApp(portal.url, ['owner@example.com'])
    const refusals: Array<[string, BodyInit | null]> = [
      ['not JSON', '{'],
      ['no body', null],
      ['an empty body', ''],
      ['a body that fails while it is read', new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('connection reset'))
        },
      })],
      ['JSON null', 'null'],
      ['a JSON array', '[]'],
      ['a JSON string', '"code"'],
      ['no verifier', JSON.stringify({ code: 'x' })],
      ['a verifier of the wrong shape', JSON.stringify({ code: 'x', verifier: 'short' })],
      ['no code', JSON.stringify({ verifier: 'a'.repeat(43) })],
      ['a code that is not text', JSON.stringify({ code: 7, verifier: 'a'.repeat(43) })],
    ]
    for (const [name, body] of refusals) {
      const res = await app.request(exchangePost(body))
      assertEquals(res.status, 400, name)
      assertEquals((await res.json() as { error: string }).error, NOT_CONFIRMED, name)
    }

    const stranger = await app.request(exchangePost(JSON.stringify({ code: 'never-issued', verifier: 'a'.repeat(43) })))
    assertEquals(stranger.status, 400, 'a code that was never issued')
    assertEquals((await stranger.json() as { error: string }).error, EXPIRED)

    const { verifier, challenge } = await createPkcePair()
    const code = new URL(await shellCallback(app, challenge)).searchParams.get('code')!
    const wrong = await app.request(exchangePost(JSON.stringify({ code, verifier: (await createPkcePair()).verifier })))
    assertEquals(wrong.status, 400, 'a verifier that does not match the challenge')
    assertEquals((await wrong.json() as { error: string }).error, NOT_CONFIRMED)
    const spent = await app.request(exchangePost(JSON.stringify({ code, verifier })))
    assertEquals(spent.status, 400, 'the failed attempt used the code up')
    assertEquals((await spent.json() as { error: string }).error, EXPIRED)
  } finally {
    await portal.close()
  }
})

// ── The budget is per address, and behind a reverse proxy that is one address for everybody ───────
//
// `vite preview` proxies /authenticate to Deno (vite.config.ts PROXIED_ROUTES, docs/operations/DEPLOY.md),
// and a Hub install is served at a public APP_BASE_URL, so a proxy stands in front of Deno there too.
// Wherever that is so, the connection Deno sees comes from the proxy whoever the caller is, and the
// budget is one bucket for everybody. A stranger who spends it must not turn a real sign-in away, so a
// request that names a live one-time code (the sign-in itself, which a stranger cannot name: 32 random
// bytes) is never charged to it.

/** What a stranger can send. None of it names a live code, so all of it is charged to the budget. */
const JUNK_EXCHANGES: Array<[string, () => BodyInit | null]> = [
  ['a verifier of the wrong shape', () => JSON.stringify({ code: 'x', verifier: 'short' })],
  ['a well-formed exchange for a code never issued', () => JSON.stringify({ code: 'never-issued', verifier: 'a'.repeat(43) })],
  ['not JSON', () => '{'],
  ['no body', () => null],
]
const junk = (): BodyInit => JSON.stringify({ code: 'x', verifier: 'short' })

/** Exchange requests as if they came from `address`: the connection's own address, plus whatever headers the client sets. */
function exchangeFrom(app: Hono, address: string) {
  return (body: BodyInit | null, headers: Record<string, string> = {}) =>
    app.request(exchangePost(body, headers), undefined, { remoteAddr: { hostname: address } })
}

/** Spends an address's whole minute on junk, then checks that it is spent. */
async function spendBudget(from: ReturnType<typeof exchangeFrom>): Promise<void> {
  for (let i = 0; i < EXCHANGE_MAX_PER_MINUTE; i++) {
    const [kind, body] = JUNK_EXCHANGES[i % JUNK_EXCHANGES.length]
    const res = await from(body())
    assertEquals(res.status, 400, `junk request ${i + 1} (${kind}) is inside the budget`)
    await res.body?.cancel()
  }
  const over = await from(junk())
  assertEquals(over.status, 429, 'the junk request after the budget')
  await over.body?.cancel()
}

/** A real shell sign-in: the body its exchange sends, for a code the server has just issued. */
async function signInBody(app: Hono): Promise<{ body: string; code: string; verifier: string }> {
  const { verifier, challenge } = await createPkcePair()
  const code = new URL(await shellCallback(app, challenge)).searchParams.get('code')!
  return { body: JSON.stringify({ code, verifier }), code, verifier }
}

Deno.test('shell exchange: past its budget an address gets 429 with Retry-After, whatever junk it sends, and only that address does', async () => {
  const app = testApp('https://portal.example', ['a@b.c'])
  const stranger = exchangeFrom(app, '203.0.113.7')
  await spendBudget(stranger)

  // Every kind of request that names no live code is refused, and says how long to wait and why.
  for (const [kind, body] of JUNK_EXCHANGES) {
    const res = await stranger(body())
    assertEquals(res.status, 429, kind)
    assertEquals(res.headers.get('retry-after'), '60', `${kind}: it says how long to wait`)
    assert(typeof (await res.json() as { error?: unknown }).error === 'string', `${kind}: and why`)
  }

  // The budget is the connection's. A header the client sets is not a key: rotating it buys nothing.
  assertEquals((await stranger(junk(), { 'x-forwarded-for': '192.0.2.99' })).status, 429, 'X-Forwarded-For is not the address')
  assertEquals((await stranger(junk(), { 'x-real-ip': '192.0.2.98', forwarded: 'for=192.0.2.97' })).status, 429)

  // Someone else's address has a budget of its own, and a spoofed header does not spend it.
  const other = await exchangeFrom(app, '198.51.100.2')(junk(), { 'x-forwarded-for': '203.0.113.7' })
  assertEquals(other.status, 400, 'a different address is not limited')
  await other.body?.cancel()
})

Deno.test('shell exchange: a live code still exchanges from an address whose budget is spent, and junk from it is still refused', async () => {
  const portal = stubPortal({ email: 'owner@example.com' })
  try {
    const app = testApp(portal.url, ['owner@example.com'])
    // Behind the proxy every caller is this one address, so a stranger's junk and the shell's sign-in share a budget.
    const viaProxy = exchangeFrom(app, '127.0.0.1')
    await spendBudget(viaProxy)

    const signIn = await signInBody(app)
    const real = await viaProxy(signIn.body)
    assertEquals(real.status, 200, 'the sign-in itself is not turned away for the junk that spent the budget')
    const session = await real.json() as { token: string; email: string }
    assertEquals(session.email, 'owner@example.com')
    assert(await verifySession(session.token, 'integration-secret'), 'and what it gets is the shell session')

    // That did not refill the budget: junk is still refused. The exemption was the code's, and the code is spent.
    assertEquals((await viaProxy(junk())).status, 429, 'junk is still refused')
    assertEquals((await viaProxy(signIn.body)).status, 429, 'a spent code exempts nothing')
  } finally {
    await portal.close()
  }
})

Deno.test('shell exchange: over budget, a live code with the wrong verifier is answered by the code store, and is used up', async () => {
  const portal = stubPortal({ email: 'owner@example.com' })
  try {
    const app = testApp(portal.url, ['owner@example.com'])
    const viaProxy = exchangeFrom(app, '127.0.0.1')
    await spendBudget(viaProxy)

    const signIn = await signInBody(app)
    const wrong = await viaProxy(JSON.stringify({ code: signIn.code, verifier: (await createPkcePair()).verifier }))
    assertEquals(wrong.status, 400, 'a request that names a live code is not refused for the budget')
    assertEquals((await wrong.json() as { error: string }).error, NOT_CONFIRMED)

    // One guess per code, whatever the budget says: the failed attempt used the code up, so the retry is just junk.
    const retry = await viaProxy(signIn.body)
    assertEquals(retry.status, 429, 'the exemption went with the code')
    await retry.body?.cancel()
  } finally {
    await portal.close()
  }
})

Deno.test('shell exchange: the size cap holds for an address past its budget too, because the body is read to find a live code', async () => {
  const app = testApp('https://portal.example', ['a@b.c'])
  const viaProxy = exchangeFrom(app, '127.0.0.1')
  await spendBudget(viaProxy)

  const declared = countedStream([new Uint8Array(10)])
  const refused = await viaProxy(declared.body, { 'content-length': String(EXCHANGE_MAX_BODY_BYTES + 1) })
  assertEquals(refused.status, 413, 'a length declared over the cap')
  assertEquals(declared.pulled(), 0, 'is refused without reading a byte')
  await refused.body?.cancel()

  const endless = countedStream(Array.from({ length: 1024 }, () => new Uint8Array(1024).fill(0x20)))
  const cut = await viaProxy(endless.body)
  assertEquals(cut.status, 413, 'a body with no declared length')
  const allowedChunks = EXCHANGE_MAX_BODY_BYTES / 1024 + 2
  assert(endless.pulled() <= allowedChunks, `read ${endless.pulled()} of 1024 chunks, more than the ${allowedChunks} the cap allows`)
  await cut.body?.cancel()
})

/** Runs `fn` with Date.now() held where the test puts it. The code's minute and the budget's window both read it. */
async function withClock<T>(fn: (clock: { at(msAfterStart: number): void }) => Promise<T>): Promise<T> {
  const real = Date.now
  const start = real()
  let now = start
  Date.now = () => now
  try {
    return await fn({ at: (ms) => { now = start + ms } })
  } finally {
    Date.now = real
  }
}

Deno.test('shell exchange: a code is live for its minute and dead after it, and a dead code is no exemption from the budget', async () => {
  const portal = stubPortal({ email: 'owner@example.com' })
  try {
    await withClock(async (clock) => {
      const app = testApp(portal.url, ['owner@example.com'])
      const viaProxy = exchangeFrom(app, '127.0.0.1')
      const early = await signInBody(app) // issued at 0 s, exchanged at 59 s
      const late = await signInBody(app) // issued at 0 s, exchanged at 61 s

      clock.at(30_000)
      await spendBudget(viaProxy) // the junk is dated 30 s, so it still counts at 61 s and has aged out by 91 s

      clock.at(59_000)
      const live = await viaProxy(early.body)
      assertEquals(live.status, 200, 'a code 59 s old is live, so the spent budget does not matter')
      await live.body?.cancel()

      clock.at(61_000)
      const dead = await viaProxy(late.body)
      assertEquals(dead.status, 429, 'a code 61 s old is dead: it names nothing live, so it is charged, and the budget is spent')
      await dead.body?.cancel()

      clock.at(91_000)
      const gone = await viaProxy(late.body)
      assertEquals(gone.status, 400, 'with the budget free again, the dead code is simply not found')
      assertEquals((await gone.json() as { error: string }).error, EXPIRED)
    })
  } finally {
    await portal.close()
  }
})
