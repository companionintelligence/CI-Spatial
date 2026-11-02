/**
 * Companion Account sign-in in the Capacitor shells.
 *
 * The shell's page lives on capacitor://localhost (iOS) or https://localhost (Android), and
 * the server's session cookie belongs to the server's origin, so the shell cannot carry it.
 * Sign-in runs in the system browser sheet instead. The server ends it by handing the app a
 * one-time code through the app's URL scheme. The shell trades that code, with the PKCE
 * verifier only it holds, for a session token, and sends the token as a Bearer header.
 *
 * The server half is server/portal_auth.ts (SHELL_RETURN_URL, POST /authenticate/shell/exchange).
 * The plugins are read from Capacitor.Plugins, so the web build does not bundle them.
 */
import { apiUrl, isNativeShell } from './api-base.ts'

/** The app's URL scheme and sign-in host. Keep in step with SHELL_RETURN_URL in server/portal_auth.ts. */
export const SHELL_RETURN_PREFIX = 'com.companionintelligence.scan://auth'

const PENDING_KEY = 'companion-scan-shell-sign-in'
const TOKEN_KEY = 'companion-scan-shell-session'
/** A sign-in that has not come back to the app in this long is abandoned. */
const PENDING_TTL_MS = 10 * 60_000
const CHECK_TIMEOUT_MS = 8_000
const CODE_SHAPE = /^[A-Za-z0-9_-]{43}$/

/** The part of Capacitor's plugin registry this module uses. A web page has none of it. */
interface NativePlugins {
  App?: {
    addListener(event: 'appUrlOpen', listener: (event: { url: string }) => void): Promise<unknown>
    getLaunchUrl?: () => Promise<{ url?: string } | undefined>
  }
  Browser?: {
    open(options: { url: string }): Promise<void>
    close(): Promise<void>
  }
}

function plugins(): NativePlugins {
  return (globalThis as { Capacitor?: { Plugins?: NativePlugins } }).Capacitor?.Plugins ?? {}
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A PKCE pair as the server makes one (RFC 7636, S256). */
export async function createShellPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

/** Storage can be blocked (private windows, cleared site data). Without it a sign-in cannot resume; nothing else breaks. */
function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key)
    else globalThis.localStorage?.setItem(key, value)
  } catch {
    // Blocked storage: the sign-in cannot resume, and the status row says it did not finish.
  }
}

/** The server path that starts a shell sign-in, with the shell's PKCE challenge. */
export function shellSignInPath(challenge: string): string {
  return `/authenticate/oidc?shell=1&challenge=${challenge}`
}

/** The verifier of a sign-in the app started recently, or null. */
function pendingVerifier(): string | null {
  const raw = readStorage(PENDING_KEY)
  if (!raw) return null
  try {
    const pending = JSON.parse(raw) as { verifier?: unknown; startedAt?: unknown }
    const fresh = typeof pending.startedAt === 'number' && Date.now() - pending.startedAt < PENDING_TTL_MS
    return fresh && typeof pending.verifier === 'string' ? pending.verifier : null
  } catch {
    return null
  }
}

/**
 * Opens the server's sign-in in the browser sheet. The verifier waits in storage
 * until the app comes back. Throws if the Browser plugin is not in this build.
 */
export async function beginShellSignIn(): Promise<void> {
  const browser = plugins().Browser
  if (!browser) throw new Error('The Browser plugin is not in this build')
  const { verifier, challenge } = await createShellPkce()
  writeStorage(PENDING_KEY, JSON.stringify({ verifier, startedAt: Date.now() }))
  await browser.open({ url: apiUrl(shellSignInPath(challenge)) })
}

/**
 * Finishes a sign-in that came back to the app through `url`. Returns true when the
 * shell now holds a session, false when the sign-in failed, and null when `url` is not
 * a return for a sign-in this app started (a duplicate, a stale launch URL, or any other link).
 */
export async function finishShellSignIn(url: string): Promise<boolean | null> {
  if (!url.startsWith(`${SHELL_RETURN_PREFIX}?`)) return null
  const verifier = pendingVerifier()
  if (!verifier) return null
  writeStorage(PENDING_KEY, null)
  void plugins().Browser?.close().catch(() => undefined)
  const code = new URL(url).searchParams.get('code') ?? ''
  if (!CODE_SHAPE.test(code)) return false
  try {
    const res = await fetch(apiUrl('/authenticate/shell/exchange'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, verifier }),
      credentials: 'omit',
    })
    const body = await res.json().catch(() => null) as { token?: unknown } | null
    if (!res.ok || typeof body?.token !== 'string') return false
    writeStorage(TOKEN_KEY, body.token)
    return true
  } catch {
    return false
  }
}

/**
 * Whether the stored shell token still signs in. The server refusing it (expired, or the
 * account since removed from the allowlist) clears it. Outside a shell there is no token.
 */
export async function shellSignedIn(fetchFn: typeof fetch = fetch): Promise<boolean> {
  const token = isNativeShell() ? readStorage(TOKEN_KEY) : null
  if (!token) return false
  try {
    const res = await fetchFn(apiUrl('/authenticate/whoami'), {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) writeStorage(TOKEN_KEY, null)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Listens for the app's URL opens, so a sign-in that ends while the app runs is finished here,
 * and so is one that launched the app from cold. `onFinished` gets the result of each sign-in
 * this app started. Does nothing outside a shell.
 */
export async function initShellSignIn(onFinished: (signedIn: boolean) => void): Promise<void> {
  if (!isNativeShell()) return
  const app = plugins().App
  if (!app) return
  const finish = async (url: string | undefined) => {
    if (!url) return
    const result = await finishShellSignIn(url)
    if (result !== null) onFinished(result)
  }
  await app.addListener('appUrlOpen', ({ url }) => { void finish(url) })
  void finish((await app.getLaunchUrl?.())?.url)
}
