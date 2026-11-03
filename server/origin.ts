/**
 * Which browser origins may call the Scan. The CORS middleware and the WebSocket upgrade both ask
 * this. A WebSocket skips CORS, so the upgrade has to check the Origin header itself.
 */

/** The iOS shell loads the app from this origin (mobile/capacitor.config.ts). The Android shell's https://localhost passes the localhost rule. */
export const NATIVE_SHELL_ORIGIN = 'capacitor://localhost'

export interface OriginAllowlist {
  /** ALLOWED_ORIGIN_PREFIX, a tailnet origin by default. Matched whole: `https://host` admits `https://host:8443`, never `https://host.example.com`. */
  prefix: string
  /** The app's own public address (APP_BASE_URL). Its page calls the Scan from there. */
  publicOrigin: string | null
}

/** The origin of `url`, or null when it is missing or not a URL. */
export function originOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function isAllowedOrigin(origin: string, allowlist: OriginAllowlist): boolean {
  if (origin === NATIVE_SHELL_ORIGIN) return true
  if (origin === allowlist.publicOrigin) return true
  try {
    const { hostname, protocol } = new URL(origin)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return true
    if (hostname.endsWith('.ts.net')) return true
    if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true
    if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(hostname)) return true
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(hostname)) return true
    return origin === allowlist.prefix || origin.startsWith(`${allowlist.prefix}:`)
  } catch {
    return false
  }
}
