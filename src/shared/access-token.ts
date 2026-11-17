/**
 * The access token a page was opened with (`?token=`), and how it rides on a request.
 *
 * The desktop world editor (src/viewer/viewer.ts) and the headset editor
 * (src/viewer/xr-world.ts) both talk to the Scan server with it, so the two share
 * this one definition: a `token` query parameter on the URL, and a Bearer header on
 * the fetches that can carry one.
 */
import { apiUrl } from './api-base'

/** The `token` parameter of a page's query string, or '' when the page has none. */
export function accessTokenFrom(search: string): string {
  return new URLSearchParams(search).get('token') || ''
}

/** A server path with `token` added as a `token` parameter. Unchanged without a token. */
export function addAccessToken(url: string, token: string): string {
  const target = apiUrl(url)
  if (!token) return target
  const parsed = new URL(target, location.origin)
  parsed.searchParams.set('token', token)
  return target.startsWith('/') ? parsed.pathname + parsed.search + parsed.hash : parsed.href
}

/** `extra` plus an Authorization header carrying `token`. Unchanged without a token. */
export function accessTokenHeaders(token: string, extra: HeadersInit = {}): HeadersInit {
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra
}
