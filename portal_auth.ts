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
 * Routes (all inert 404s unless PORTAL_OIDC_ENABLED=1):
 *   GET  /authenticate/oidc            → 302 to Portal authorize (sets state+PKCE cookies)
 *   GET  /authenticate/oidc/callback   → validates state, exchanges code, mints session
 *   GET  /authenticate/whoami          → { sub, email, name } for a valid session; also
 *                                        accepts a Portal-issued Bearer JWT (JWKS-verified)
 *   POST /authenticate/logout          → clears the session cookie
 *
 * Env (names follow CI-Server / CI-Common):
 *   PORTAL_OIDC_ENABLED        master switch (default: off)
 *   OIDC_ISSUER_URL            Portal origin, e.g. https://portal.example.com
 *   OIDC_CLIENT_ID             public client id (default: ci-web-xr-scan) — must be
 *                              registered in Portal's PUBLIC_CLIENTS
 *   APP_BASE_URL               this app's stable public origin (Hub-injected);
 *                              falls back to x-forwarded-proto/host, then Host
 *   PORTAL_OIDC_ALLOWED_EMAILS comma-separated account allowlist (empty = reject)
 *   PORTAL_OIDC_JWKS_URI       JWKS endpoint (default: ${issuer}/api/auth/jwks)
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
  jwksUri: string
  audience: string[]
  sessionSecret: string
  /** Session lifetime in seconds (default 7 days). */
  sessionTtlSec: number
}

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
    jwksUri: env('PORTAL_OIDC_JWKS_URI') ?? (issuerUrl ? `${issuerUrl}/api/auth/jwks` : ''),
    audience: (env('PORTAL_OIDC_AUDIENCE') ?? clientId)
      .split(',').map((s) => s.trim()).filter(Boolean),
    sessionSecret: env('SESSION_SECRET') ?? crypto.randomUUID() + crypto.randomUUID(),
    sessionTtlSec: 7 * 24 * 60 * 60,
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
    claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as SessionClaims
  } catch { return null }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') return null
  return claims
}

/** Open-redirect guard: only same-origin relative paths survive (CI-Server's safeRelativePath). */
export function safeRelativePath(p: string | undefined | null): string | null {
  if (!p) return null
  if (!p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\')) return null
  if (p.includes('://') || p.includes('\r') || p.includes('\n')) return null
  return p
}

// ── Route registration ────────────────────────────────────────────────────────

export interface PortalAuthDeps {
  /** Returns the post-login destination (e.g. the owner share link for the default world). */
  ownerDestination: () => Promise<string>
}

const STATE_COOKIE = 'oidc_state'
const PKCE_COOKIE = 'oidc_pkce'
const REDIRECT_COOKIE = 'oidc_redirect'
const SESSION_COOKIE = 'cs_session'
const HANDSHAKE_TTL_SEC = 600

function cookie(c: Context, name: string): string | null {
  const header = c.req.header('cookie') ?? ''
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1))
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

export function registerPortalAuth(app: Hono, cfg: PortalAuthConfig, deps: PortalAuthDeps) {
  if (!cfg.enabled) return
  if (!cfg.issuerUrl) {
    console.warn('[portal-auth] PORTAL_OIDC_ENABLED is set but OIDC_ISSUER_URL is empty — sign-in disabled')
    return
  }
  console.log(`[portal-auth] Companion Account sign-in enabled (issuer ${cfg.issuerUrl}, client ${cfg.clientId})`)
  const jwks = cfg.jwksUri ? createRemoteJWKSet(new URL(cfg.jwksUri)) : null

  // 1. Initiate: PKCE + state cookies, redirect to Portal authorize.
  app.get('/authenticate/oidc', async (c) => {
    const { verifier, challenge } = await createPkcePair()
    const state = createStateNonce()
    setCookie(c, STATE_COOKIE, state, HANDSHAKE_TTL_SEC, '/authenticate')
    setCookie(c, PKCE_COOKIE, verifier, HANDSHAKE_TTL_SEC, '/authenticate')
    const wanted = safeRelativePath(c.req.query('redirect'))
    if (wanted) setCookie(c, REDIRECT_COOKIE, wanted, HANDSHAKE_TTL_SEC, '/authenticate')

    const redirectUri = `${resolveBaseUrl(c, cfg)}/authenticate/oidc/callback`
    const url = new URL(`${cfg.issuerUrl}/api/auth/oauth2/authorize`)
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
      tokenResp = await fetch(`${cfg.issuerUrl}/api/auth/oauth2/token`, {
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

    const uiResp = await fetch(`${cfg.issuerUrl}/api/auth/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null)
    if (!uiResp?.ok) return c.text('Could not load your Companion Account profile', 502)
    const profile = await uiResp.json() as { sub?: string; email?: string; name?: string }
    if (!profile.sub || !profile.email) return c.text('Your Companion Account has no verified email', 403)

    if (!cfg.allowedEmails.includes(profile.email.toLowerCase())) {
      console.warn(`[portal-auth] rejected sign-in for ${profile.email} (not in PORTAL_OIDC_ALLOWED_EMAILS)`)
      return c.text('This Companion Account is not authorized for this scanner', 403)
    }

    const claims: SessionClaims = {
      sub: profile.sub,
      email: profile.email,
      name: profile.name,
      exp: Math.floor(Date.now() / 1000) + cfg.sessionTtlSec,
    }
    setCookie(c, SESSION_COOKIE, await signSession(claims, cfg.sessionSecret), cfg.sessionTtlSec)
    console.log(`[portal-auth] ${profile.email} signed in via Companion Account`)

    const wanted = safeRelativePath(cookie(c, REDIRECT_COOKIE))
    clearCookie(c, REDIRECT_COOKIE, '/authenticate')
    return c.redirect(wanted ?? await deps.ownerDestination(), 302)
  })

  // 3. Who am I — session cookie, or a Portal-issued Bearer JWT (resource-server path).
  app.get('/authenticate/whoami', async (c) => {
    const sess = cookie(c, SESSION_COOKIE)
    if (sess) {
      const claims = await verifySession(sess, cfg.sessionSecret)
      if (claims) return c.json({ sub: claims.sub, email: claims.email, name: claims.name ?? null, via: 'session' })
    }
    const auth = c.req.header('authorization')
    if (auth?.startsWith('Bearer ') && jwks) {
      try {
        // Portal's Better-Auth jwt plugin issues iss = `${origin}/api/auth`.
        const { payload } = await jwtVerify(auth.slice(7), jwks, {
          issuer: `${cfg.issuerUrl}/api/auth`,
          audience: cfg.audience,
        })
        return c.json({ sub: payload.sub, email: payload['email'] ?? null, name: payload['name'] ?? null, via: 'portal-jwt' })
      } catch { /* fall through to 401 */ }
    }
    return c.json({ error: 'Not signed in' }, 401)
  })

  app.post('/authenticate/logout', (c) => {
    clearCookie(c, SESSION_COOKIE)
    return c.json({ ok: true })
  })
}
