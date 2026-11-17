/**
 * Which browser origins may call the Scan. The CORS middleware, the WebSocket upgrade and the two
 * file routes that build their own Response all ask this. A WebSocket skips CORS, so the upgrade
 * has to check the Origin header itself.
 *
 * Only configured origins are admitted: the tailnet host and prefix, the app's public address and
 * the native shells (iOS, Android and desktop). Localhost and private-network addresses are for dev machines only, behind
 * ALLOW_DEV_ORIGINS=1. Any other *.ts.net name is refused, because every Tailscale tailnet shares
 * that suffix and a page on another tailnet must not be able to make credentialed requests here.
 */

/** The iOS shell loads the app from this origin (mobile/capacitor.config.ts). */
export const NATIVE_SHELL_ORIGIN = 'capacitor://localhost'

/**
 * The desktop shell's origins (desktop/, Tauri 2). macOS and Linux serve the bundle from
 * tauri://localhost, and Windows from http://tauri.localhost, or https://tauri.localhost when a
 * window sets useHttpsScheme. Each is accepted as it is, the way the iOS shell's is: a longer host,
 * a port or another scheme is not one of them.
 */
export const DESKTOP_SHELL_ORIGINS: readonly string[] = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]

/** The Android shell's origin (mobile/capacitor.config.ts, androidScheme https). */
export const ANDROID_SHELL_ORIGIN = 'https://localhost'

/**
 * True when `origin` is a native shell's own page: the app's bundle on the device, which no one
 * else can open. It may call the Scan, but it is no address to put in a link for anyone else.
 */
export function isNativeShellOrigin(origin: string): boolean {
  return origin === NATIVE_SHELL_ORIGIN || origin === ANDROID_SHELL_ORIGIN || DESKTOP_SHELL_ORIGINS.includes(origin)
}

export interface OriginAllowlist {
  /** ALLOWED_ORIGIN_PREFIX, a tailnet origin by default. Matched whole: `https://host` admits `https://host:8443`, never `https://host.example.com`. */
  prefix: string
  /** TAILSCALE_HOSTNAME as an origin (`https://host`), matched whole like `prefix`. Null when unset. */
  tailnetOrigin?: string | null
  /** The app's own public address (APP_BASE_URL). Its page calls the Scan from there. */
  publicOrigin: string | null
  /** Admit localhost and private-network addresses. Dev machines only (ALLOW_DEV_ORIGINS=1). */
  devOrigins?: boolean
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

/** `origin` is `prefix` itself or `prefix` with a port: the whole host, never a longer host name. */
function isUnderPrefix(origin: string, prefix: string | null | undefined): boolean {
  if (!prefix) return false
  return origin === prefix || origin.startsWith(`${prefix}:`)
}

export function isAllowedOrigin(origin: string, allowlist: OriginAllowlist): boolean {
  if (isNativeShellOrigin(origin)) return true
  if (origin === allowlist.publicOrigin) return true
  if (isUnderPrefix(origin, allowlist.prefix) || isUnderPrefix(origin, allowlist.tailnetOrigin)) return true
  if (!allowlist.devOrigins) return false
  try {
    const { hostname, protocol } = new URL(origin)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return true
    if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true
    if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(hostname)) return true
    return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(hostname)
  } catch {
    return false
  }
}

/**
 * Headers for a route that builds its own Response (the GLB and splat files). Echoes the caller's
 * origin only when it is allowed, never `*`. `Vary: Origin` stops a shared cache from handing one
 * origin's answer to another.
 */
export function originResponseHeaders(origin: string | null | undefined, allowlist: OriginAllowlist): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' }
  if (origin && isAllowedOrigin(origin, allowlist)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}
