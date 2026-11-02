/**
 * portal_discovery.test.ts — CI-Portal's OpenID metadata: which document is read, what is accepted,
 * how long it is kept, and that sign-in and the Portal-token check use what it names.
 * Run: deno test --allow-read --allow-write --allow-env --allow-net tests/unit/deno/portal_discovery.test.ts
 */
import { Hono } from 'hono'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import {
  configFromEnv,
  createMetadataCache,
  defaultMetadata,
  discoverPortal,
  metadataUrls,
  parseMetadata,
  registerPortalAuth,
  type PortalAuthConfig,
} from '../../../server/portal_auth.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEquals<T>(a: T, b: T, msg?: string) {
  if (a !== b) throw new Error(`${msg ?? 'assertEquals'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}

const ORIGIN = 'https://portal.example'

/** The document CI-Portal publishes, as the live Hub serves it. Overrides replace single fields. */
function portalDoc(origin: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
    token_endpoint: `${origin}/api/auth/oauth2/token`,
    userinfo_endpoint: `${origin}/api/auth/oauth2/userinfo`,
    jwks_uri: `${origin}/api/auth/jwks`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    ...overrides,
  }
}

/** A fetch that answers from a table of exact URLs, records each call, and answers 404 for the rest. */
function scriptedFetch(
  routes: Record<string, () => Response | Promise<Response>>,
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchFn = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    const route = routes[url]
    return route ? Promise.resolve(route()) : Promise.resolve(new Response('not found', { status: 404 }))
  }) as unknown as typeof fetch
  return { fetch: fetchFn, calls }
}

function appConfig(issuerUrl: string, overrides: Partial<PortalAuthConfig> = {}): PortalAuthConfig {
  return {
    enabled: true,
    issuerUrl,
    clientId: 'ci-web-xr-scan',
    publicBaseUrl: 'https://scan.example',
    allowedEmails: [],
    jwksUri: '',
    audience: ['ci-web-xr-scan'],
    sessionSecret: 'discovery-secret',
    sessionTtlSec: 3600,
    ...overrides,
  }
}

Deno.test('metadataUrls: the OIDC Discovery location first, then the place CI-Portal serves it', () => {
  assertEquals(
    JSON.stringify(metadataUrls(ORIGIN)),
    JSON.stringify([`${ORIGIN}/.well-known/openid-configuration`, `${ORIGIN}/api/auth/.well-known/openid-configuration`]),
  )
})

Deno.test('parseMetadata: accepts the document CI-Portal publishes', () => {
  const m = parseMetadata(portalDoc(ORIGIN), ORIGIN)
  assert(m !== null, 'accepted')
  assertEquals(m.source, 'discovered')
  assertEquals(m.authorizationEndpoint, `${ORIGIN}/api/auth/oauth2/authorize`)
  assertEquals(m.tokenEndpoint, `${ORIGIN}/api/auth/oauth2/token`)
  assertEquals(m.userinfoEndpoint, `${ORIGIN}/api/auth/oauth2/userinfo`)
  assertEquals(m.jwksUri, `${ORIGIN}/api/auth/jwks`)
})

Deno.test('parseMetadata: uses the endpoints the Portal names, not the usual paths', () => {
  const m = parseMetadata(
    portalDoc(ORIGIN, { authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token` }),
    ORIGIN,
  )
  assert(m !== null, 'accepted')
  assertEquals(m.authorizationEndpoint, `${ORIGIN}/oauth/authorize`)
  assertEquals(m.tokenEndpoint, `${ORIGIN}/oauth/token`)
})

Deno.test('parseMetadata: rejects a document for another issuer', () => {
  assertEquals(parseMetadata(portalDoc('https://evil.example'), ORIGIN), null, 'issuer mismatch')
  assertEquals(parseMetadata(portalDoc(`${ORIGIN}/elsewhere`), ORIGIN), null, 'issuer with a path')
})

Deno.test('parseMetadata: rejects a document that sends the sign-in or the code exchange off the origin', () => {
  assertEquals(parseMetadata(portalDoc(ORIGIN, { authorization_endpoint: 'https://evil.example/authorize' }), ORIGIN), null)
  assertEquals(parseMetadata(portalDoc(ORIGIN, { token_endpoint: 'http://portal.example/api/auth/oauth2/token' }), ORIGIN), null)
  assertEquals(parseMetadata(portalDoc(ORIGIN, { jwks_uri: 'not a url' }), ORIGIN), null)
  assertEquals(parseMetadata(portalDoc(ORIGIN, { authorization_endpoint: undefined }), ORIGIN), null, 'required endpoint missing')
})

Deno.test('parseMetadata: a Portal that lists its methods must offer PKCE S256 and the code flow', () => {
  assertEquals(parseMetadata(portalDoc(ORIGIN, { code_challenge_methods_supported: ['plain'] }), ORIGIN), null)
  assertEquals(parseMetadata(portalDoc(ORIGIN, { response_types_supported: ['token'] }), ORIGIN), null)
  const bare = portalDoc(ORIGIN)
  delete bare.code_challenge_methods_supported
  assert(parseMetadata(bare, ORIGIN) !== null, 'accepted when the methods are not listed')
})

Deno.test('parseMetadata: an endpoint the Portal does not advertise falls back to its usual path', () => {
  const bare = portalDoc(ORIGIN)
  delete bare.userinfo_endpoint
  delete bare.jwks_uri
  const m = parseMetadata(bare, ORIGIN)
  assert(m !== null, 'accepted')
  assertEquals(m.userinfoEndpoint, defaultMetadata(ORIGIN).userinfoEndpoint)
  assertEquals(m.jwksUri, defaultMetadata(ORIGIN).jwksUri)
})

Deno.test('discoverPortal: passes over the HTML a root path answers with, and reads the Better-Auth mount', async () => {
  const [standard, mount] = metadataUrls(ORIGIN)
  const { fetch: portalFetch, calls } = scriptedFetch({
    [standard]: () => new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } }),
    [mount]: () => Response.json(portalDoc(ORIGIN)),
  })
  const { metadata, problem } = await discoverPortal(ORIGIN, portalFetch)
  assertEquals(problem, null, 'no problem')
  assertEquals(metadata.source, 'discovered', 'read from the Portal')
  assertEquals(JSON.stringify(calls), JSON.stringify([standard, mount]), 'tried in order, stopping at the first good one')
})

Deno.test('discoverPortal: when no place can be read, the usual paths are used and the problem is named', async () => {
  const portalFetch = (() => Promise.reject(new TypeError('dns lookup failed'))) as unknown as typeof fetch
  const { metadata, problem } = await discoverPortal(ORIGIN, portalFetch)
  assertEquals(metadata.source, 'default', 'fallback')
  assertEquals(metadata.authorizationEndpoint, defaultMetadata(ORIGIN).authorizationEndpoint, 'the usual authorize path')
  assert(problem !== null && problem.includes('dns lookup failed'), `problem names the failure: ${problem}`)
})

Deno.test('createMetadataCache: a failed read is retried after a minute, a good one is kept for an hour', async () => {
  let clock = 0
  let mountReads = 0
  const portalFetch = ((input: string | URL | Request) => {
    if (!String(input).endsWith('/api/auth/.well-known/openid-configuration')) {
      return Promise.resolve(new Response('not found', { status: 404 }))
    }
    mountReads++
    return Promise.resolve(mountReads === 1 ? new Response('down', { status: 503 }) : Response.json(portalDoc(ORIGIN)))
  }) as unknown as typeof fetch
  const get = createMetadataCache(ORIGIN, portalFetch, () => clock)

  assertEquals((await get()).source, 'default', 'first read fails: the usual paths')
  assertEquals((await get()).source, 'default', 'inside the retry minute')
  assertEquals(mountReads, 1, 'no second read inside the minute')
  clock = 60_000
  assertEquals((await get()).source, 'discovered', 'retried after the minute')
  assertEquals((await get()).source, 'discovered', 'kept')
  assertEquals(mountReads, 2, 'one read for the good copy')
  clock = 60_000 + 60 * 60_000 - 1
  await get()
  assertEquals(mountReads, 2, 'kept for the hour')
  clock = 60_000 + 60 * 60_000
  assertEquals((await get()).source, 'discovered', 'read again once the hour is up')
  assertEquals(mountReads, 3, 'refreshed after an hour')
})

Deno.test('createMetadataCache: callers that arrive during a read share it', async () => {
  let reads = 0
  const portalFetch = ((input: string | URL | Request) => {
    if (!String(input).endsWith('/api/auth/.well-known/openid-configuration')) {
      return Promise.resolve(new Response('not found', { status: 404 }))
    }
    reads++
    return new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json(portalDoc(ORIGIN))), 20))
  }) as unknown as typeof fetch
  const get = createMetadataCache(ORIGIN, portalFetch)
  const [a, b] = await Promise.all([get(), get()])
  assertEquals(a.source, 'discovered')
  assertEquals(b.source, 'discovered')
  assertEquals(reads, 1, 'one read for both callers')
})

Deno.test('configFromEnv: the JWKS URL comes from discovery unless PORTAL_OIDC_JWKS_URI overrides it', () => {
  const base: Record<string, string> = { PORTAL_OIDC_ENABLED: '1', OIDC_ISSUER_URL: ORIGIN }
  assertEquals(configFromEnv((k) => base[k]).jwksUri, '', 'discovered by default')
  const overridden: Record<string, string> = { ...base, PORTAL_OIDC_JWKS_URI: 'https://keys.example/jwks' }
  assertEquals(configFromEnv((k) => overridden[k]).jwksUri, 'https://keys.example/jwks', 'override kept')
})

Deno.test('initiate: sends the browser to the authorize endpoint CI-Portal advertises, not the usual path', async () => {
  const [, mount] = metadataUrls(ORIGIN)
  const { fetch: portalFetch } = scriptedFetch({
    [mount]: () => Response.json(portalDoc(ORIGIN, { authorization_endpoint: `${ORIGIN}/oauth/authorize` })),
  })
  const app = new Hono()
  registerPortalAuth(app, appConfig(ORIGIN), { ownerDestination: () => Promise.resolve('/'), fetch: portalFetch })
  const res = await app.request('https://scan.example/authenticate/oidc')
  assertEquals(res.status, 302, 'redirects')
  const loc = new URL(res.headers.get('location')!)
  assertEquals(loc.origin + loc.pathname, `${ORIGIN}/oauth/authorize`, 'advertised authorize endpoint')
})

Deno.test('whoami: a Portal token is checked against the discovered JWKS, under the discovered issuer or the legacy one', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const portal = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/api/auth/.well-known/openid-configuration') return Response.json(portalDoc(u.origin))
    if (u.pathname === '/api/auth/jwks') return Response.json({ keys: [jwk] })
    return new Response('not found', { status: 404 })
  })
  try {
    const origin = `http://127.0.0.1:${(portal.addr as Deno.NetAddr).port}`
    const app = new Hono()
    registerPortalAuth(app, appConfig(origin, { allowedEmails: ['owner@example.com'] }), {
      ownerDestination: () => Promise.resolve('/'),
    })
    const sign = (iss: string) =>
      new SignJWT({ email: 'owner@example.com', email_verified: true, name: 'Owner' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setSubject('portal-user-1')
        .setIssuer(iss)
        .setAudience('ci-web-xr-scan')
        .setExpirationTime('5m')
        .sign(privateKey)
    const who = (token: string) =>
      app.request('https://scan.example/authenticate/whoami', { headers: { authorization: `Bearer ${token}` } })
    assertEquals((await who(await sign(origin))).status, 200, 'the issuer the metadata names')
    assertEquals((await who(await sign(`${origin}/api/auth`))).status, 200, 'the issuer the jwt plugin has used')
    assertEquals((await who(await sign('https://elsewhere.example'))).status, 401, 'another issuer')
  } finally {
    await portal.shutdown()
  }
})
