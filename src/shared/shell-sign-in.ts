/**
 * Companion Account sign-in in the native shells: the Capacitor phone apps and the Tauri desktop app.
 *
 * The shell's page lives on its own origin (capacitor://localhost, https://localhost,
 * tauri://localhost or http://tauri.localhost), and the server's session cookie belongs to the
 * server's origin, so the shell cannot carry it. Sign-in runs in the system browser instead: the
 * browser sheet on a phone, the default browser on a desktop. The server ends it by handing the
 * app a one-time code through the app's own URL scheme. The shell trades that code, with the PKCE
 * verifier only it holds, for a session token, and sends the token as a Bearer header.
 *
 * The server half is server/portal_auth.ts (SHELL_RETURN_URL, DESKTOP_RETURN_URL and
 * POST /authenticate/shell/exchange). The Portal only ever redirects to the Scan server's own
 * callback, so neither app scheme is registered with it. The plugins are read from
 * Capacitor.Plugins and window.__TAURI__, so the web build does not bundle them.
 */
import {
  apiBase,
  apiUrl,
  isDesktopShell,
  isNativeShell,
  SHELL_SESSION_KEY,
  SHELL_SIGN_IN_CODES_KEY,
  SHELL_SIGN_IN_PENDING_KEY,
  shellSessionToken,
} from './api-base.ts'

/** The phone app's URL scheme and sign-in host. Keep in step with SHELL_RETURN_URL in server/portal_auth.ts. */
export const SHELL_RETURN_PREFIX = 'com.companionintelligence.scan://auth'

/**
 * The desktop app's URL scheme and sign-in host, registered by its installers
 * (desktop/src-tauri/tauri.conf.json, plugins.deep-link). Keep in step with DESKTOP_RETURN_URL in
 * server/portal_auth.ts.
 */
export const DESKTOP_RETURN_PREFIX = 'computer.ci.scan.desktop://auth'

const PENDING_KEY = SHELL_SIGN_IN_PENDING_KEY
const CODES_KEY = SHELL_SIGN_IN_CODES_KEY
const TOKEN_KEY = SHELL_SESSION_KEY
/** A sign-in that has not come back to the app in this long is abandoned. */
const PENDING_TTL_MS = 10 * 60_000
/** How many of the latest return codes the app remembers, so that none is finished twice. */
const CODES_KEPT = 10
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

/**
 * The part of the desktop app's global Tauri API this module uses (tauri.conf.json sets
 * withGlobalTauri). The opener and deep-link plugins add these in desktop/src-tauri/src/main.rs.
 */
interface DesktopPlugins {
  opener?: { openUrl(url: string): Promise<void> }
  deepLink?: {
    getCurrent(): Promise<string[] | null>
    onOpenUrl(handler: (urls: string[]) => void): Promise<unknown>
  }
}

function desktopPlugins(): DesktopPlugins {
  return (globalThis as { __TAURI__?: DesktopPlugins }).__TAURI__ ?? {}
}

/** The return this app's sign-in ends in: the desktop app's scheme in the desktop shell, else the phone app's. */
function returnPrefix(): string {
  return isDesktopShell() ? DESKTOP_RETURN_PREFIX : SHELL_RETURN_PREFIX
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

/**
 * The server path that starts a shell sign-in, with the shell's PKCE challenge. `shell=1` is the
 * phone app, as it always was; `shell=desktop` makes the server return to the desktop app instead.
 */
export function shellSignInPath(challenge: string, app: 'phone' | 'desktop' = 'phone'): string {
  return `/authenticate/oidc?shell=${app === 'desktop' ? 'desktop' : '1'}&challenge=${challenge}`
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

/** How this build opens a page in the system browser: the Browser sheet on a phone, the default browser on a desktop. */
function systemBrowser(): ((url: string) => Promise<void>) | null {
  if (isDesktopShell()) {
    const opener = desktopPlugins().opener
    return opener ? (url) => opener.openUrl(url) : null
  }
  const browser = plugins().Browser
  return browser ? (url) => browser.open({ url }) : null
}

/**
 * Opens the server's sign-in in the system browser. The verifier waits in storage
 * until the app comes back. Throws if this build cannot open the system browser.
 */
export async function beginShellSignIn(): Promise<void> {
  const open = systemBrowser()
  if (!open) throw new Error('This build cannot open the system browser')
  const { verifier, challenge } = await createShellPkce()
  writeStorage(PENDING_KEY, JSON.stringify({ verifier, startedAt: Date.now() }))
  await open(apiUrl(shellSignInPath(challenge, isDesktopShell() ? 'desktop' : 'phone')))
}

/** The one-time code in a return to the app, or null when it has none of the shape the server makes. */
function returnCode(url: string): string | null {
  try {
    const code = new URL(url).searchParams.get('code') ?? ''
    return CODE_SHAPE.test(code) ? code : null
  } catch {
    return null
  }
}

/**
 * Notes `code` as handed to the app, and says whether it was handed over before. The latest
 * CODES_KEPT codes are kept, the most recently seen first, so a launch URL handed back on every
 * page load stays known however many sign-ins follow it.
 */
function seenBefore(code: string): boolean {
  let seen: string[] = []
  try {
    const list = JSON.parse(readStorage(CODES_KEY) ?? '[]') as unknown
    if (Array.isArray(list)) seen = list.filter((item): item is string => typeof item === 'string')
  } catch {
    // An unreadable list remembers nothing; it is written afresh below.
  }
  writeStorage(CODES_KEY, JSON.stringify([code, ...seen.filter((item) => item !== code)].slice(0, CODES_KEPT)))
  return seen.includes(code)
}

/**
 * Finishes a sign-in that came back to the app through `url`. Returns true when the
 * shell now holds a session, false when the sign-in failed, and null when `url` is not
 * a return for a sign-in this app started (a duplicate, a stale launch URL, or any other link).
 *
 * Two kinds of link are ignored, and leave a sign-in in progress as it was:
 * - A link to the app's scheme without a code of the shape the server sends. Any web page can
 *   open such a link, and it must not cancel the person's sign-in.
 * - A code the app was handed before. On every page load the desktop app's deep-link plugin
 *   hands over the last link of the process again (getCurrent()), and the phone app its launch
 *   URL. A return that already ended one sign-in would otherwise take the verifier of the next.
 */
export async function finishShellSignIn(url: string): Promise<boolean | null> {
  if (!url.startsWith(`${returnPrefix()}?`)) return null
  const code = returnCode(url)
  if (!code || seenBefore(code)) return null
  const verifier = pendingVerifier()
  if (!verifier) return null
  writeStorage(PENDING_KEY, null)
  // The phone's browser sheet belongs to the app and is closed. A desktop's browser is the person's own.
  void plugins().Browser?.close().catch(() => undefined)
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
 *
 * On a desktop the return comes through the deep-link plugin. On Windows and Linux the link starts
 * a second copy of the app, and the single-instance plugin hands it to this one.
 */
export async function initShellSignIn(onFinished: (signedIn: boolean) => void): Promise<void> {
  if (!isNativeShell()) return
  installShellSession()
  const finish = async (url: string | undefined) => {
    if (!url) return
    const result = await finishShellSignIn(url)
    if (result !== null) onFinished(result)
  }
  if (isDesktopShell()) {
    const deepLink = desktopPlugins().deepLink
    if (!deepLink) return
    await deepLink.onOpenUrl((urls) => { for (const url of urls) void finish(url) })
    const current = await deepLink.getCurrent().catch(() => null)
    for (const url of current ?? []) void finish(url)
    return
  }
  const app = plugins().App
  if (!app) return
  await app.addListener('appUrlOpen', ({ url }) => { void finish(url) })
  void finish((await app.getLaunchUrl?.())?.url)
}

let sessionFetchInstalled = false

/**
 * The server answers only a signed-in Companion session, and in the shell that session is a Bearer
 * token. So every request to the server carries it, unless the caller set its own Authorization:
 * fetch, and XMLHttpRequest (the photo and clip uploads). Installed once, inside any shell. The
 * server is read on every request, because the person can change it while the app runs, and a
 * request to any other origin never gets the token. `server` defaults to the current Scan server
 * (apiBase()); tests pass their own.
 */
export function installShellSession(server: string | (() => string) = apiBase): void {
  if (sessionFetchInstalled || !isNativeShell() || typeof globalThis.fetch !== 'function') return
  sessionFetchInstalled = true
  const toServer = (url: string): boolean => {
    const origin = typeof server === 'function' ? server() : server
    return origin !== '' && url.startsWith(`${origin}/`)
  }
  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const token = shellSessionToken()
    const url = input instanceof Request ? input.url : String(input)
    if (!token || !toServer(url)) return nativeFetch(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
    return nativeFetch(input, { ...init, headers })
  }) as typeof fetch

  if (typeof XMLHttpRequest !== 'function') return
  const nativeOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    Reflect.apply(nativeOpen, this, [method, url, ...rest])
    const token = shellSessionToken()
    if (token && toServer(String(url))) this.setRequestHeader('Authorization', `Bearer ${token}`)
  }
}

// Installed as soon as the module loads, so the first request of a launch already carries the token.
installShellSession()
