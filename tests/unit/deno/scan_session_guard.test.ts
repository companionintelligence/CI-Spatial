/**
 * scan_session_guard.test.ts — the Scan's API refuses a request without an allowlisted Companion
 * session, whether the session comes as the browser cookie, a Bearer token or a `token` query
 * parameter. Public routes stay open. Runs with the rest of the unit suite: deno task test
 */
import { Hono } from 'hono'
import {
  configFromEnv,
  requireScanSession,
  SESSION_COOKIE,
  signSession,
  type PortalAuthConfig,
} from '../../../server/portal_auth.ts'

const SECRET = 'test-session-secret'
const ALLOWED = 'demo-1@lifescope.io'

function assertEquals<T>(a: T, b: T, msg?: string) {
  if (a !== b) throw new Error(`${msg ?? 'assertEquals'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}

function config(): PortalAuthConfig {
  return {
    enabled: true,
    issuerUrl: 'https://portal.example',
    clientId: 'ci-web-xr-scan',
    publicBaseUrl: 'https://scan.example',
    allowedEmails: [ALLOWED],
    jwksUri: '',
    audience: ['ci-web-xr-scan'],
    sessionSecret: SECRET,
    sessionTtlSec: 3600,
  }
}

/** A tiny app shaped like the real one: the guard sits in front of a data route and a public route. */
function appWithGuard(cfg: PortalAuthConfig): Hono {
  const app = new Hono()
  const guard = requireScanSession(cfg)
  app.use('/scans', guard)
  app.use('/scans/*', guard)
  app.get('/scans', (c) => c.json({ scans: [] }))
  app.get('/scans/:name', (c) => c.json({ name: c.req.param('name') }))
  app.get('/health', (c) => c.json({ status: 'ok' }))
  return app
}

async function sessionFor(email: string, exp = Math.floor(Date.now() / 1000) + 3600): Promise<string> {
  return await signSession({ sub: 'user-1', email, exp }, SECRET)
}

Deno.test('no session: a data route answers 401', async () => {
  const res = await appWithGuard(config()).request('/scans')
  assertEquals(res.status, 401, 'status')
})

Deno.test('no session: a nested data path is guarded too', async () => {
  const res = await appWithGuard(config()).request('/scans/shot-1.json')
  assertEquals(res.status, 401, 'status')
})

Deno.test('a session cookie for an allowlisted account reaches the route', async () => {
  const token = await sessionFor(ALLOWED)
  const res = await appWithGuard(config()).request('/scans', {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  })
  assertEquals(res.status, 200, 'status')
})

Deno.test('a Bearer token for an allowlisted account reaches the route (the app)', async () => {
  const token = await sessionFor(ALLOWED)
  const res = await appWithGuard(config()).request('/scans', {
    headers: { authorization: `Bearer ${token}` },
  })
  assertEquals(res.status, 200, 'status')
})

Deno.test('a token query parameter reaches the route (media and sockets)', async () => {
  const token = await sessionFor(ALLOWED)
  const res = await appWithGuard(config()).request(`/scans?token=${token}`)
  assertEquals(res.status, 200, 'status')
})

Deno.test('a session for an account off the allowlist is refused', async () => {
  const token = await sessionFor('someone-else@example.com')
  const res = await appWithGuard(config()).request('/scans', {
    headers: { authorization: `Bearer ${token}` },
  })
  assertEquals(res.status, 401, 'status')
})

Deno.test('an expired session is refused', async () => {
  const token = await sessionFor(ALLOWED, Math.floor(Date.now() / 1000) - 60)
  const res = await appWithGuard(config()).request('/scans', {
    headers: { authorization: `Bearer ${token}` },
  })
  assertEquals(res.status, 401, 'status')
})

Deno.test('a tampered session is refused', async () => {
  const token = await sessionFor(ALLOWED)
  const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA')
  const res = await appWithGuard(config()).request('/scans', {
    headers: { authorization: `Bearer ${forged}` },
  })
  assertEquals(res.status, 401, 'status')
})

Deno.test('a token that is not a Companion session is refused', async () => {
  const res = await appWithGuard(config()).request('/scans', {
    headers: { authorization: 'Bearer not-a-session' },
  })
  assertEquals(res.status, 401, 'status')
})

Deno.test('the public health route needs no session', async () => {
  const res = await appWithGuard(config()).request('/health')
  assertEquals(res.status, 200, 'status')
})

Deno.test('configs built without SESSION_SECRET in one process share a key, so sign-in and the guard agree', async () => {
  const env = (k: string) => (k === 'PORTAL_OIDC_ALLOWED_EMAILS' ? ALLOWED : undefined)
  const signing = configFromEnv(env)
  const guarding = configFromEnv(env)
  const token = await signSession({ sub: 'user-1', email: ALLOWED, exp: Math.floor(Date.now() / 1000) + 3600 }, signing.sessionSecret)
  const res = await appWithGuard(guarding).request('/scans', {
    headers: { authorization: `Bearer ${token}` },
  })
  assertEquals(res.status, 200, 'status')
})
