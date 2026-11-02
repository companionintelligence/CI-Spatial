/// <reference types="vite/client" />

/**
 * Where the Scan server is, as seen from the page.
 *
 * In a browser the page is served by the server, so a root-relative path such
 * as `/projects` is enough and `VITE_API_BASE` stays unset. The Capacitor
 * shells load the bundle from `capacitor://localhost` (iOS) or
 * `https://localhost` (Android), where a root-relative path reaches nothing.
 * `mobile/` builds set `VITE_API_BASE` to the server's https origin, and these
 * helpers put that origin in front of every server path. With it unset, every
 * URL comes out unchanged.
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

const API_BASE = ((import.meta.env?.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '')

/** A server path such as `/projects` as a URL to request. */
export function apiUrl(path: string): string {
  return resolveApiUrl(API_BASE, path)
}

/** A server path such as `/events` as a WebSocket URL. */
export function wsUrl(path: string): string {
  return resolveWsUrl(API_BASE, path, location)
}

/** The `credentials` a request to `path` needs. Cookies cross to another origin only with `include`. */
export function resolveApiCredentials(base: string): RequestCredentials {
  return base ? 'include' : 'same-origin'
}

/** The `credentials` for a request made with `apiUrl()`. */
export function apiCredentials(): RequestCredentials {
  return resolveApiCredentials(API_BASE)
}

/**
 * True inside a Capacitor shell. The shell's page is on another origin than the
 * server, so the server's session cookie never reaches it. A shell signs in through
 * src/shared/shell-sign-in.ts and holds a Bearer token instead.
 */
export function isNativeShell(): boolean {
  const cap = (globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return cap?.isNativePlatform?.() === true
}
