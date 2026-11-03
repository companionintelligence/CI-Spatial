/**
 * portal_auth.ts — "Sign in with Companion Account" (CI-Portal OIDC).
 *
 * Mirrors the shipped CI-Server integration (OidcController, PR #1442) and the
 * @companionintelligence/auth conventions from CI-Common: CI-Portal is the
 * OIDC IdP (Better-Auth), this app is a *public* PKCE client — no client
 * secret, Authorization-Code + PKCE (S256) with a state cookie, token exchange
 * and userinfo server-side, then a locally-minted HMAC session cookie.
 *
 * What a login unlocks: this app's authorization model is per-world member
 * tokens (owner/editor/viewer/scanner share links). A Portal-authenticated,
 * allowlisted account is redirected into the world editor carrying the OWNER
 * token — so the share-link plumbing stays the single authz mechanism.
 * Per CI-Common's email-trust policy this uses allowlist-only gating
 * (PORTAL_OIDC_ALLOWED_EMAILS); an empty allowlist fails closed.
 *
 * Routes (all but /status are inert 404s unless PORTAL_OIDC_ENABLED=1):
 *   GET  /authenticate/status          → { enabled }, boolean only. Always registered, so
 *                                        "off on this install" can be told from "on".
 *   GET  /authenticate/oidc            → 302 to Portal authorize (sets state+PKCE cookies)
 *   GET  /authenticate/oidc/callback   → validates state, exchanges code, mints session
 *   GET  /authenticate/oidc?shell=1&challenge=…  → the same, for a native shell. The callback ends
 *                                        in SHELL_RETURN_URL with a one-time code, not a cookie
 *   POST /authenticate/shell/exchange  → { code, verifier } → { token, email, name }, the shell's session
 *   GET  /authenticate/whoami          → { sub, email, name } for a valid session; also accepts the
 *                                        shell's Bearer token, or a Portal-issued Bearer JWT (JWKS-verified)
 *   POST /authenticate/logout          → clears the session cookie
 *
 * Env (names follow CI-Server / CI-Common):
 *   PORTAL_OIDC_ENABLED        master switch (default: off)
 *   OIDC_ISSUER_URL            Portal origin, e.g. https://portal.example.com. The sign-in
 *                              endpoints are discovered from it (see discoverPortal)
 *   OIDC_CLIENT_ID             public client id (default: ci-web-xr-scan) — must be
 *                              registered in Portal's PUBLIC_CLIENTS
 *   APP_BASE_URL               this app's stable public origin (Hub-injected);
 *                              falls back to x-forwarded-proto/host, then Host
 *   PORTAL_OIDC_ALLOWED_EMAILS comma-separated account allowlist (empty = reject)
 *   PORTAL_OIDC_JWKS_URI       optional JWKS override (default: the discovered jwks_uri)
 *   PORTAL_OIDC_AUDIENCE       comma-separated accepted aud values (default: client id)
 *   SESSION_SECRET             HMAC key for the session cookie (default: random per
 *                              boot — restarts invalidate sessions)
 */
import type { Context, Hono } from 'hono'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// ── Config ────────────────────────────────────────────────────────────────────

export interface PortalAuthConfig {
  enabled: boolean
  issuerUrl: string
  clientId: string
  publicBaseUrl: string | null
  allowedEmails: string[]
  /** Optional JWKS override. Empty means the jwks_uri CI-Portal publishes. */
  jwksUri: string
  audience: string[]
  sessionSecret: string
  /** Session lifetime in seconds (default 7 days). */
  sessionTtlSec: number
}

/**
 * The session key when SESSION_SECRET is unset: random once per process, so every config built in
 * this process signs and checks with the same key. Drawing it per call split sign-in from the guard.
 */
const PROCESS_SESSION_SECRET = crypto.randomUUID() + crypto.randomUUID()

export function configFromEnv(env: (k: string) => string | undefined = Deno.env.get): PortalAuthConfig {
  const issuerUrl = (env('OIDC_ISSUER_URL') ?? '').replace(/\/+$/, '')
  const clientId = env('OIDC_CLIENT_ID') ?? 'ci-web-xr-scan'
  return {
    enabled: env('PORTAL_OIDC_ENABLED') === '1' || env('PORTAL_OIDC_ENABLED') === 'true',
    issuerUrl,
    clientId,
    publicBaseUrl: env('APP_BASE_URL')?.replace(/\/+$/, '') ?? null,
    allowedEmails: (env('PORTAL_OIDC_ALLOWED_EMAILS') ?? '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    jwksUri: env('PORTAL_OIDC_JWKS_URI') ?? '',
    audience: (env('PORTAL_OIDC_AUDIENCE') ?? clientId)
      .split(',').map((s) => s.trim()).filter(Boolean),
    sessionSecret: env('SESSION_SECRET') ?? PROCESS_SESSION_SECRET,
    sessionTtlSec: 7 * 24 * 60 * 60,
  }
}

// ── CI-Portal metadata (OpenID Connect Discovery) ────────────────────────────

/** The part of CI-Portal's OpenID metadata this app uses. */
export interface PortalMetadata {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string
  jwksUri: string
  /** `discovered` when the Portal's own metadata was read; `default` when it could not be. */
  source: 'discovered' | 'default'
}

/**
 * Where CI-Portal's metadata may be published, in the order tried. The first is the OIDC Discovery 1.0
 * location. The second is where CI-Portal's Better-Auth serves it: its issuer is the bare origin, so the
 * document sits under /api/auth, not at the origin root, where the Hub answers with its web app.
 */
export function metadataUrls(issuerUrl: string): string[] {
  return [
    `${issuerUrl}/.well-known/openid-configuration`,
    `${issuerUrl}/api/auth/.well-known/openid-configuration`,
  ]
}

/** The paths CI-Portal has always been reached at. Used only when its metadata cannot be read. */
export function defaultMetadata(issuerUrl: string): PortalMetadata {
  return {
    issuer: issuerUrl,
    authorizationEndpoint: `${issuerUrl}/api/auth/oauth2/authorize`,
    tokenEndpoint: `${issuerUrl}/api/auth/oauth2/token`,
    userinfoEndpoint: `${issuerUrl}/api/auth/oauth2/userinfo`,
    jwksUri: `${issuerUrl}/api/auth/jwks`,
    source: 'default',
  }
}

/**
 * Accepts a metadata document only if it describes this issuer. Its issuer identifier must be the one
 * configured, and every endpoint it names must be on that origin, so a document cannot send the sign-in
 * or the code exchange anywhere else. Where it lists its methods, it must offer the code flow with PKCE
 * S256. Anything else is null.
 */
export function parseMetadata(doc: unknown, issuerUrl: string): PortalMetadata | null {
  if (!doc || typeof doc !== 'object') return null
  const d = doc as Record<string, unknown>
  if (typeof d.issuer !== 'string' || d.issuer.replace(/\/+$/, '') !== issuerUrl) return null
  const origin = new URL(issuerUrl).origin
  // undefined: not advertised. false: advertised, but not a URL on this origin.
  const endpoint = (key: string): string | undefined | false => {
    const value = d[key]
    if (value === undefined) return undefined
    try {
      return typeof value === 'string' && new URL(value).origin === origin ? value : false
    } catch {
      return false
    }
  }
  const authorization = endpoint('authorization_endpoint')
  const token = endpoint('token_endpoint')
  const userinfo = endpoint('userinfo_endpoint')
  const jwks = endpoint('jwks_uri')
  if (!authorization || !token || userinfo === false || jwks === false) return null
  const methods = d.code_challenge_methods_supported
  if (Array.isArray(methods) && !methods.includes('S256')) return null
  const responseTypes = d.response_types_supported
  if (Array.isArray(responseTypes) && !responseTypes.includes('code')) return null
  const fallback = defaultMetadata(issuerUrl)
  return {
    issuer: issuerUrl,
    authorizationEndpoint: authorization,
    tokenEndpoint: token,
    userinfoEndpoint: userinfo ?? fallback.userinfoEndpoint,
    jwksUri: jwks ?? fallback.jwksUri,
    source: 'discovered',
  }
}

/**
 * Reads CI-Portal's metadata from the first place it is published that passes parseMetadata. When none
 * does, the usual paths come back, and `problem` names what was wrong with each place tried.
 */
export async function discoverPortal(
  issuerUrl: string,
  fetchFn: typeof fetch,
): Promise<{ metadata: PortalMetadata; problem: string | null }> {
  const problems: string[] = []
  for (const url of metadataUrls(issuerUrl)) {
    try {
      const res = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000) })
      if (!res.ok) {
        await res.body?.cancel()
        problems.push(`${url} answered ${res.status}`)
        continue
      }
      // A path the Portal does not serve can come back as its web app's HTML. That is not a metadata document.
      if (!(res.headers.get('content-type') ?? '').includes('json')) {
        await res.body?.cancel()
        problems.push(`${url} is not JSON`)
        continue
      }
      const metadata = parseMetadata(await res.json(), issuerUrl)
      if (metadata) return { metadata, problem: null }
      problems.push(`${url} does not describe ${issuerUrl}`)
    } catch (e) {
      problems.push(`${url}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { metadata: defaultMetadata(issuerUrl), problem: problems.join('; ') }
}

/** A successful read is kept for an hour; a failed one is tried again after a minute. */
const METADATA_TTL_MS = 60 * 60 * 1000
const METADATA_RETRY_MS = 60 * 1000

/**
 * The metadata for one issuer, read on first use and then on that schedule. Callers that arrive while a
 * read is in flight share it. Each read is logged, so the setup log says what this boot found.
 */
export function createMetadataCache(
  issuerUrl: string,
  fetchFn: typeof fetch,
  now: () => number = Date.now,
): () => Promise<PortalMetadata> {
  let current: { metadata: PortalMetadata; expiresAt: number } | null = null
  let inflight: Promise<PortalMetadata> | null = null
  const read = async (): Promise<PortalMetadata> => {
    const { metadata, problem } = await discoverPortal(issuerUrl, fetchFn)
    current = { metadata, expiresAt: now() + (problem ? METADATA_RETRY_MS : METADATA_TTL_MS) }
    if (problem) {
      console.warn(`[portal-auth] CI-Portal metadata not discovered (${problem}); using the default endpoints`)
    } else {
      console.log(`[portal-auth] CI-Portal metadata discovered for ${issuerUrl}`)
    }
    return metadata
  }
  return () => {
    if (current && current.expiresAt > now()) return Promise.resolve(current.metadata)
    inflight ??= read().finally(() => {
      inflight = null
    })
    return inflight
  }
}

// ── Small crypto helpers (PKCE, HMAC session) ────────────────────────────────

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** RFC 7636 S256 pair: verifier = base64url(32 random bytes), challenge = base64url(sha256(verifier)). */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: b64url(new Uint8Array(digest)) }
}

export function createStateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Equal length and equal bytes, with no early exit on the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  )
}

export interface SessionClaims { sub: string; email: string; name?: string; exp: number }

export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payload))
  return `${payload}.${b64url(new Uint8Array(sig))}`
}

export async function verifySession(token: string, secret: string): Promise<SessionClaims | null> {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)
  // Recompute the MAC over the payload string itself and let WebCrypto do the
  // (timing-safe) comparison — never re-serialize the claims to compare.
  let sig: Uint8Array<ArrayBuffer>
  try {
    const raw = atob(sigB64.replace(/-/g, '+').replace(/_/g, '/'))
    sig = new Uint8Array(new ArrayBuffer(raw.length))
    for (let i = 0; i < raw.length; i++) sig[i] = raw.charCodeAt(i)
  } catch { return null }
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, new TextEncoder().encode(payload))
  if (!valid) return null
  let claims: SessionClaims
  try {
    // The payload was signed as UTF-8 bytes; atob yields latin-1, so decode
    // through TextDecoder or any non-ASCII name comes back as mojibake.
    const raw = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    claims = JSON.parse(new TextDecoder().decode(bytes)) as SessionClaims
  } catch { return null }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') return null
  return claims
}

/**
 * The single authorization decision, so every entry point applies the same
 * gate. An empty allowlist authorizes nobody (documented fail-closed).
 */
export function isAllowedEmail(cfg: PortalAuthConfig, email: string | undefined | null): boolean {
  if (!email) return false
  return cfg.allowedEmails.includes(email.trim().toLowerCase())
}

/**
 * Who is calling, as a Companion Account session: the session cookie in a browser, the shell's
 * Bearer token in the app, or the same token as a `token` query parameter, for media and
 * WebSocket URLs that cannot carry a header. Only an allowlisted email counts.
 */
export async function scanSessionFor(c: Context, cfg: PortalAuthConfig): Promise<SessionClaims | null> {
  const candidates: string[] = []
  const sess = cookie(c, SESSION_COOKIE)
  if (sess) candidates.push(sess)
  const auth = c.req.header('authorization')
  if (auth?.startsWith('Bearer ')) candidates.push(auth.slice(7))
  const queryToken = c.req.query('token')
  if (queryToken) candidates.push(queryToken)
  for (const token of candidates) {
    const claims = await verifySession(token, cfg.sessionSecret)
    if (claims && isAllowedEmail(cfg, claims.email)) return claims
  }
  return null
}

/** Middleware for the Scan's own API: a request without an allowlisted Companion session gets a 401. */
export function requireScanSession(cfg: PortalAuthConfig) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const claims = await scanSessionFor(c, cfg)
    if (!claims) return c.json({ error: 'Sign in with your Companion Account to use this Scan.' }, 401)
    await next()
  }
}

/**
 * Open-redirect guard: only same-origin relative paths survive.
 *
 * Pattern-matching alone is not enough. The WHATWG URL parser strips ASCII
 * tab/CR/LF *before* parsing, so "/\t/evil.example" — which passes a naive
 * startsWith('//') check — is resolved by the browser as protocol-relative and
 * lands on https://evil.example/. Reject control characters outright, then
 * normalize through the parser and re-serialize, so backslash and dot tricks
 * are canonicalized away instead of enumerated.
 */
export function safeRelativePath(p: string | undefined | null): string | null {
  if (!p) return null
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return null
  if (!p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\')) return null
  if (p.includes('://')) return null
  const SENTINEL = 'http://local.invalid'
  let u: URL
  try {
    u = new URL(p, SENTINEL)
  } catch {
    return null
  }
  // Anything that escaped the sentinel origin was not a relative path.
  if (u.origin !== SENTINEL) return null
  return `${u.pathname}${u.search}${u.hash}`
}

// ── Route registration ────────────────────────────────────────────────────────

export interface PortalAuthDeps {
  /** Returns the post-login destination (e.g. the owner share link for the default world). */
  ownerDestination: () => Promise<string>
  /** Carries discovery and the Portal's token and userinfo calls. Tests pass a stub. */
  fetch?: typeof fetch
}

const STATE_COOKIE = 'oidc_state'
const PKCE_COOKIE = 'oidc_pkce'
const REDIRECT_COOKIE = 'oidc_redirect'
export const SESSION_COOKIE = 'cs_session'
const SHELL_CHALLENGE_COOKIE = 'oidc_shell'
const HANDSHAKE_TTL_SEC = 600
/**
 * Where a shell sign-in ends. Fixed, never read from the request, so the redirect cannot be aimed
 * elsewhere. It is the app's bundle id, registered as a URL scheme in mobile/ios and mobile/android.
 * Keep it in step with SHELL_RETURN_PREFIX in src/shared/shell-sign-in.ts.
 */
export const SHELL_RETURN_URL = 'com.companionintelligence.scan://auth'
/** How long the one-time code from a shell sign-in waits to be exchanged. */
const SHELL_CODE_TTL_MS = 60_000
/** A PKCE verifier or challenge: 32 random bytes, base64url, 43 characters. */
const PKCE_SHAPE = /^[A-Za-z0-9_-]{43}$/

function cookie(c: Context, name: string): string | null {
  const header = c.req.header('cookie') ?? ''
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq) === name) {
      const raw = part.slice(eq + 1)
      // A malformed percent-escape must not throw: an attacker-set (or merely
      // corrupted) cookie would otherwise surface as a 500 from the error
      // handler and wedge sign-in until the browser is cleared.
      try {
        return decodeURIComponent(raw)
      } catch {
        return raw
      }
    }
  }
  return null
}

function setCookie(c: Context, name: string, value: string, maxAgeSec: number, path = '/') {
  const secure = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'
  c.header('Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    { append: true })
}

function clearCookie(c: Context, name: string, path = '/') {
  c.header('Set-Cookie', `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax`, { append: true })
}

/** Resolve this app's externally-reachable origin for redirect_uri construction. */
export function resolveBaseUrl(c: Context, cfg: PortalAuthConfig): string {
  if (cfg.publicBaseUrl) return cfg.publicBaseUrl
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '')
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host
  return `${proto}://${host}`
}

/** True only when the master switch is on AND an issuer is set. This is what GET /authenticate/status reports. */
export function signInEnabled(cfg: PortalAuthConfig): boolean {
  return cfg.enabled && cfg.issuerUrl !== ''
}

export function registerPortalAuth(app: Hono, cfg: PortalAuthConfig, deps: PortalAuthDeps) {
  // Registered before the early return below, and nothing else on this path is:
  // a stock install must be able to say sign-in is off, and this route says only that.
  app.get('/authenticate/status', (c) => c.json({ enabled: signInEnabled(cfg) }))
  if (!cfg.enabled) return
  if (!cfg.issuerUrl) {
    console.warn('[portal-auth] PORTAL_OIDC_ENABLED is set but OIDC_ISSUER_URL is empty — sign-in disabled')
    return
  }
  console.log(`[portal-auth] Companion Account sign-in enabled (issuer ${cfg.issuerUrl}, client ${cfg.clientId})`)
  const portalFetch = deps.fetch ?? fetch
  const metadata = createMetadataCache(cfg.issuerUrl, portalFetch)
  // Read at boot, so the setup log says what CI-Portal offered before anyone signs in.
  void metadata()
  // One JWKS set per URL: jose caches the keys it has fetched inside the set.
  let jwksSet: { url: string; keys: ReturnType<typeof createRemoteJWKSet> } | null = null
  const jwksFor = (url: string) => {
    const current = jwksSet
    if (current && current.url === url) return current.keys
    const keys = createRemoteJWKSet(new URL(url))
    jwksSet = { url, keys }
    return keys
  }
  // One-time codes from shell sign-ins, waiting for the shell to exchange them. In memory on purpose:
  // a code lives for a minute, and a restart only sends the shell back to sign in again.
  const shellCodes = new Map<string, { challenge: string; claims: SessionClaims; expiresAt: number }>()
  const sweepShellCodes = () => {
    const now = Date.now()
    for (const [code, entry] of shellCodes) if (entry.expiresAt < now) shellCodes.delete(code)
  }

  // 1. Initiate: PKCE + state cookies, redirect to Portal authorize.
  app.get('/authenticate/oidc', async (c) => {
    // A shell sign-in carries the PKCE challenge the shell made. The callback keeps it, so only the
    // shell that started the sign-in can exchange the code the callback issues.
    const shell = c.req.query('shell') === '1'
    const shellChallenge = c.req.query('challenge') ?? ''
    if (shell && !PKCE_SHAPE.test(shellChallenge)) return c.text('Shell sign-in needs a PKCE challenge', 400)
    if (shell) setCookie(c, SHELL_CHALLENGE_COOKIE, shellChallenge, HANDSHAKE_TTL_SEC, '/authenticate')
    else clearCookie(c, SHELL_CHALLENGE_COOKIE, '/authenticate')
    const { verifier, challenge } = await createPkcePair()
    const state = createStateNonce()
    setCookie(c, STATE_COOKIE, state, HANDSHAKE_TTL_SEC, '/authenticate')
    setCookie(c, PKCE_COOKIE, verifier, HANDSHAKE_TTL_SEC, '/authenticate')
    const wanted = safeRelativePath(c.req.query('redirect'))
    if (wanted) setCookie(c, REDIRECT_COOKIE, wanted, HANDSHAKE_TTL_SEC, '/authenticate')

    const redirectUri = `${resolveBaseUrl(c, cfg)}/authenticate/oidc/callback`
    const url = new URL((await metadata()).authorizationEndpoint)
    url.searchParams.set('client_id', cfg.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'openid email profile')
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return c.redirect(url.toString(), 302)
  })

  // 2. Callback: validate state, exchange code (PKCE), userinfo, allowlist, session.
  app.get('/authenticate/oidc/callback', async (c) => {
    const err = c.req.query('error')
    if (err) return c.text(`Portal sign-in failed: ${err}`, 400)
    const code = c.req.query('code')
    const state = c.req.query('state')
    const cookieState = cookie(c, STATE_COOKIE)
    const verifier = cookie(c, PKCE_COOKIE)
    clearCookie(c, STATE_COOKIE, '/authenticate')
    clearCookie(c, PKCE_COOKIE, '/authenticate')
    if (!code || !state || !cookieState || state !== cookieState) {
      return c.text('Sign-in state mismatch — please try again', 400)
    }
    if (!verifier) return c.text('Sign-in session expired — please try again', 400)

    const redirectUri = `${resolveBaseUrl(c, cfg)}/authenticate/oidc/callback`
    let tokenResp: Response
    try {
      tokenResp = await portalFetch((await metadata()).tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: cfg.clientId,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (e) {
      console.error('[portal-auth] token exchange unreachable:', e)
      return c.text('Portal is unreachable — please try again later', 502)
    }
    if (!tokenResp.ok) {
      console.error('[portal-auth] token exchange failed:', tokenResp.status, await tokenResp.text().catch(() => ''))
      return c.text('Portal rejected the sign-in — please try again', 502)
    }
    const tokens = await tokenResp.json() as { access_token?: string }
    if (!tokens.access_token) return c.text('Portal returned no access token', 502)

    const uiResp = await portalFetch((await metadata()).userinfoEndpoint, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null)
    if (!uiResp?.ok) return c.text('Could not load your Companion Account profile', 502)
    const profile = await uiResp.json() as {
      sub?: string
      email?: string
      email_verified?: boolean
      name?: string
    }
    if (!profile.sub || !profile.email) return c.text('Your Companion Account has no email', 403)
    // Authorizing on an email the IdP has not verified is the standard OIDC
    // account-takeover path: anyone who can register that address at Portal
    // would inherit the allowlist entry. Require the claim to be strictly true
    // — absent counts as unverified, and fails closed.
    if (profile.email_verified !== true) {
      console.warn(`[portal-auth] rejected sign-in for ${profile.email}: email_verified is not true`)
      return c.text(
        'Your Companion Account email is not verified. Verify it in the Portal and try again.',
        403,
      )
    }

    if (!isAllowedEmail(cfg, profile.email)) {
      console.warn(`[portal-auth] rejected sign-in for ${profile.email} (not in PORTAL_OIDC_ALLOWED_EMAILS)`)
      return c.text('This Companion Account is not authorized for this scanner', 403)
    }

    const claims: SessionClaims = {
      sub: profile.sub,
      email: profile.email,
      name: profile.name,
      exp: Math.floor(Date.now() / 1000) + cfg.sessionTtlSec,
    }
    const shellChallenge = cookie(c, SHELL_CHALLENGE_COOKIE)
    clearCookie(c, SHELL_CHALLENGE_COOKIE, '/authenticate')
    if (shellChallenge && PKCE_SHAPE.test(shellChallenge)) {
      // The shell's origin never receives the session cookie, which belongs to this server's origin.
      // It gets a one-time code instead, and trades it, with its own verifier, for the session token.
      sweepShellCodes()
      const shellCode = b64url(crypto.getRandomValues(new Uint8Array(32)))
      shellCodes.set(shellCode, { challenge: shellChallenge, claims, expiresAt: Date.now() + SHELL_CODE_TTL_MS })
      clearCookie(c, REDIRECT_COOKIE, '/authenticate')
      console.log(`[portal-auth] ${profile.email} signed in via Companion Account (shell)`)
      return c.redirect(`${SHELL_RETURN_URL}?code=${shellCode}`, 302)
    }

    setCookie(c, SESSION_COOKIE, await signSession(claims, cfg.sessionSecret), cfg.sessionTtlSec)
    console.log(`[portal-auth] ${profile.email} signed in via Companion Account`)

    const wanted = safeRelativePath(cookie(c, REDIRECT_COOKIE))
    clearCookie(c, REDIRECT_COOKIE, '/authenticate')
    return c.redirect(wanted ?? await deps.ownerDestination(), 302)
  })

  // 2b. Shell exchange: the one-time code, plus the verifier only the shell holds, for the session token.
  app.post('/authenticate/shell/exchange', async (c) => {
    const body = await c.req.json().catch(() => null) as { code?: unknown; verifier?: unknown } | null
    const code = typeof body?.code === 'string' ? body.code : ''
    const verifier = typeof body?.verifier === 'string' ? body.verifier : ''
    if (!code || !PKCE_SHAPE.test(verifier)) {
      return c.json({ error: 'Sign-in could not be confirmed. Start again.' }, 400)
    }
    sweepShellCodes()
    const entry = shellCodes.get(code)
    shellCodes.delete(code) // single use, whatever the verifier turns out to be
    if (!entry) return c.json({ error: 'Sign-in expired. Start again.' }, 400)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    if (!sameText(b64url(new Uint8Array(digest)), entry.challenge)) {
      return c.json({ error: 'Sign-in could not be confirmed. Start again.' }, 400)
    }
    c.header('Cache-Control', 'no-store')
    return c.json({
      token: await signSession(entry.claims, cfg.sessionSecret),
      email: entry.claims.email,
      name: entry.claims.name ?? null,
    })
  })

  // 3. Who am I — session cookie, the shell's Bearer token, or a Portal-issued Bearer JWT (resource-server path).
  app.get('/authenticate/whoami', async (c) => {
    const sess = cookie(c, SESSION_COOKIE)
    if (sess) {
      const claims = await verifySession(sess, cfg.sessionSecret)
      if (claims) return c.json({ sub: claims.sub, email: claims.email, name: claims.name ?? null, via: 'session' })
    }
    const auth = c.req.header('authorization')
    if (auth?.startsWith('Bearer ')) {
      // The shell's token is the same signed session, read from the header. The allowlist is checked on every call,
      // so removing an email from PORTAL_OIDC_ALLOWED_EMAILS ends that account's shell access at once.
      const claims = await verifySession(auth.slice(7), cfg.sessionSecret)
      if (claims) {
        if (!isAllowedEmail(cfg, claims.email)) return c.json({ error: 'Not authorized for this scanner' }, 403)
        return c.json({ sub: claims.sub, email: claims.email, name: claims.name ?? null, via: 'shell-token' })
      }
    }
    if (auth?.startsWith('Bearer ')) {
      try {
        const meta = await metadata()
        // The metadata names the bare origin as issuer. The Better-Auth jwt plugin has always put
        // `${origin}/api/auth` in iss, so both name this Portal and both are accepted.
        const { payload } = await jwtVerify(auth.slice(7), jwksFor(cfg.jwksUri || meta.jwksUri), {
          issuer: [meta.issuer, `${cfg.issuerUrl}/api/auth`],
          audience: cfg.audience,
        })
        // A valid Portal token proves *who* the caller is, not that they are
        // authorized here — apply the same allowlist + verified-email gate as
        // the interactive path, or this route becomes a bypass of it.
        const email = typeof payload['email'] === 'string' ? payload['email'] : null
        if (payload['email_verified'] !== true || !isAllowedEmail(cfg, email)) {
          return c.json({ error: 'Not authorized for this scanner' }, 403)
        }
        return c.json({ sub: payload.sub, email, name: payload['name'] ?? null, via: 'portal-jwt' })
      } catch { /* fall through to 401 */ }
    }
    return c.json({ error: 'Not signed in' }, 401)
  })

  app.post('/authenticate/logout', (c) => {
    clearCookie(c, SESSION_COOKIE)
    return c.json({ ok: true })
  })
}
