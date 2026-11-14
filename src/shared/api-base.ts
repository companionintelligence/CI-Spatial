/// <reference types="vite/client" />
import { SCAN_SERVER_KEY } from './storage-keys.ts'

/**
 * Where the Scan server is, as seen from the page.
 *
 * In a browser the page is served by the server, so a root-relative path such
 * as `/projects` is enough and `VITE_API_BASE` stays unset. The native shells
 * load the bundle from their own origin, where a root-relative path reaches
 * nothing: `capacitor://localhost` (iOS), `https://localhost` (Android), and
 * `tauri://localhost` or `http://tauri.localhost` (desktop). A shell talks to
 * the Scan server whose address the person saved on the device (the first-run
 * Server row, or the editor's menu). A build may also name a default with
 * `VITE_API_BASE`; a saved address wins over it. These helpers put that origin
 * in front of every server path.
 *
 * A browser never reads the saved address. With `VITE_API_BASE` unset, which is
 * how the public site is built, every URL comes out unchanged.
 */

/** `path` on the server at `base`. Absolute URLs and protocol-relative ones pass through. */
export function resolveApiUrl(base: string, path: string): string {
  if (!base || !path.startsWith('/') || path.startsWith('//')) return path
  return base + path
}

/** `path` on the server at `base` as a WebSocket URL. Without a base, the page's own host. */
export function resolveWsUrl(
  base: string,
  path: string,
  page: { protocol: string; host: string },
): string {
  if (base) return base.replace(/^http/, 'ws') + path
  const proto = page.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${page.host}${path}`
}

/** The server origin this build was made for (`VITE_API_BASE`), or '' when it names none. */
const BUILD_API_BASE = ((import.meta.env?.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '')

/** True inside a Capacitor shell (Android, iOS). Capacitor injects its bridge before any page script runs. */
export function isCapacitorShell(): boolean {
  const cap = (globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return cap?.isNativePlatform?.() === true
}

/** True inside the Tauri desktop shell. Tauri 2 gives every page it serves `__TAURI_INTERNALS__` before any page script runs. */
export function isDesktopShell(): boolean {
  const internals = (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  return typeof internals === 'object' && internals !== null
}

/**
 * True inside a native shell. The shell's page is on another origin than the
 * server, so the server's session cookie never reaches it. A shell signs in through
 * src/shared/shell-sign-in.ts and holds a Bearer token instead.
 */
export function isNativeShell(): boolean {
  return isCapacitorShell() || isDesktopShell()
}

/** Why a typed server address was refused. */
export type ServerAddressProblem = 'empty' | 'not-a-url' | 'not-https' | 'has-path' | 'has-credentials' | 'own-origin'

export type ServerAddress = { ok: true; origin: string } | { ok: false; problem: ServerAddressProblem }

/**
 * The Scan server origin in what someone typed, or why it is refused.
 *
 * `scan.example.ts.net` reads as `https://scan.example.ts.net`. Only https is
 * accepted: a Companion Hub and a tailnet server both serve the Scan over TLS, the
 * Android shell refuses cleartext, and the session token must not cross a network
 * in the clear. The address is an origin. A path, query or fragment is refused
 * rather than dropped, because the Scan's routes sit at the root of its origin and
 * a silently shortened address would point at the wrong thing. `ownOrigin` is the
 * page's own origin: an address equal to it would ask the app's bundle, not a server.
 */
export function parseServerAddress(input: string, ownOrigin?: string): ServerAddress {
  const text = input.trim()
  if (!text) return { ok: false, problem: 'empty' }
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(text)
  let url: URL
  try {
    url = new URL(hasScheme ? text : `https://${text}`)
  } catch {
    return { ok: false, problem: 'not-a-url' }
  }
  if (url.protocol !== 'https:') return { ok: false, problem: 'not-https' }
  if (!url.hostname) return { ok: false, problem: 'not-a-url' }
  if (url.username || url.password) return { ok: false, problem: 'has-credentials' }
  if (url.pathname !== '/' || url.search || url.hash) return { ok: false, problem: 'has-path' }
  if (ownOrigin && url.origin === ownOrigin) return { ok: false, problem: 'own-origin' }
  return { ok: true, origin: url.origin }
}

/** Storage can be blocked (private windows, cleared site data). A blocked read is no value. */
function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | null): boolean {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key)
    else globalThis.localStorage?.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/** The Scan server address saved on this device, or null. A saved value that no longer parses counts as none. */
export function savedServerAddress(): string | null {
  const saved = readStored(SCAN_SERVER_KEY)
  if (!saved) return null
  const parsed = parseServerAddress(saved)
  return parsed.ok ? parsed.origin : null
}

/**
 * The Scan server's origin, or '' for the page's own origin. A shell uses the address
 * saved on the device, else the one this build names. A browser uses the build's, which
 * the public site leaves unset.
 */
export function apiBase(): string {
  return (isNativeShell() ? savedServerAddress() : null) ?? BUILD_API_BASE
}

/** Fired on `globalThis` after the saved server address changes, so a page can redraw what it read from the old one. */
export const SCAN_SERVER_CHANGE_EVENT = 'companion-scan-server-change'

/**
 * Saves `origin` (a parsed address) as this device's Scan server. A different server
 * also drops the session token and any sign-in in progress, which belong to the old
 * server and must never be sent to the new one. Returns false when storage is blocked.
 */
export function saveServerAddress(origin: string): boolean {
  const previous = savedServerAddress()
  if (!writeStored(SCAN_SERVER_KEY, origin)) return false
  if (previous !== origin) {
    writeStored(SHELL_SESSION_KEY, null)
    writeStored(SHELL_SIGN_IN_PENDING_KEY, null)
  }
  const target = globalThis as unknown as { dispatchEvent?: (event: Event) => boolean }
  if (typeof target.dispatchEvent === 'function' && typeof Event === 'function') {
    target.dispatchEvent(new Event(SCAN_SERVER_CHANGE_EVENT))
  }
  return true
}

/** A server path such as `/projects` as a URL to request. */
export function apiUrl(path: string): string {
  return resolveApiUrl(apiBase(), path)
}

/** A server path such as `/events` as a WebSocket URL. A shell adds its session token, since a socket cannot send a header. */
export function wsUrl(path: string): string {
  return withSessionToken(resolveWsUrl(apiBase(), path, location), shellSessionToken())
}

/** The `credentials` a request to `path` needs. Cookies cross to another origin only with `include`. */
export function resolveApiCredentials(base: string): RequestCredentials {
  return base ? 'include' : 'same-origin'
}

/** The `credentials` for a request made with `apiUrl()`. */
export function apiCredentials(): RequestCredentials {
  return resolveApiCredentials(apiBase())
}

/**
 * The editor page. A Scan server, and the public site, rewrite `/editor` to
 * viewer.html. A shell serves its bundle as plain files with no rewrite, and an
 * unknown path there falls back to the scanner, so a shell links the file itself.
 */
export function editorPath(search = ''): string {
  return `${isNativeShell() ? '/viewer.html' : '/editor'}${search}`
}

/** Where a shell keeps its Companion session token (src/shared/shell-sign-in.ts writes it). */
export const SHELL_SESSION_KEY = 'companion-scan-shell-session'

/** Where a shell keeps the PKCE verifier of a sign-in it started, until the browser hands the app back. */
export const SHELL_SIGN_IN_PENDING_KEY = 'companion-scan-shell-sign-in'

/** The shell's session token, or null outside a shell or before its sign-in. Blocked storage reads as no token. */
export function shellSessionToken(): string | null {
  if (!isNativeShell()) return null
  return readStored(SHELL_SESSION_KEY)
}

/**
 * `url` with the session token as a `token` parameter, for the requests that cannot send a header:
 * media and sockets. Unchanged without a token.
 */
export function withSessionToken(url: string, token: string | null): string {
  if (!token) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}token=${encodeURIComponent(token)}`
}
