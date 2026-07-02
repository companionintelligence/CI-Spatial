import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FALLBACK_HOSTNAME = 'liambook.capybara-ulmer.ts.net'

/**
 * The HTTPS hostname phones use to reach this dev/preview server.
 * Resolution order (first hit wins):
 *   1. TAILSCALE_HOSTNAME / VITE_HOSTNAME env var
 *   2. `tailscale status --json` → Self.DNSName (works on Linux + macOS CLI installs)
 *   3. a <hostname>.ts.net.crt file sitting in the repo root (tailscale cert output)
 *   4. historical default (liambook)
 */
function resolveHostname(): { hostname: string; source: string } {
  const fromEnv = process.env.TAILSCALE_HOSTNAME ?? process.env.VITE_HOSTNAME
  if (fromEnv) return { hostname: fromEnv, source: 'env' }

  const tailscaleBins = [
    'tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ]
  for (const bin of tailscaleBins) {
    try {
      const out = execFileSync(bin, ['status', '--json'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      const dns = JSON.parse(out.toString())?.Self?.DNSName
      if (typeof dns === 'string' && dns.length > 0) {
        return { hostname: dns.replace(/\.$/, ''), source: 'tailscale cli' }
      }
    } catch { /* not installed / not running — try next */ }
  }

  try {
    const crt = fs.readdirSync(process.cwd()).find((f) => f.endsWith('.ts.net.crt'))
    if (crt) return { hostname: crt.replace(/\.crt$/, ''), source: 'cert file' }
  } catch { /* unreadable cwd — fall through */ }

  return { hostname: FALLBACK_HOSTNAME, source: 'default' }
}

const { hostname: HOSTNAME, source: HOSTNAME_SOURCE } = resolveHostname()
console.log(`[vite] Hostname: ${HOSTNAME} (via ${HOSTNAME_SOURCE})`)

// Deno API server the proxy forwards to. Overridable so test harnesses can
// point one Vite instance at an isolated server (e.g. API_TARGET=http://localhost:8100).
const API_TARGET = process.env.API_TARGET ?? 'http://localhost:8000'
const WS_TARGET = API_TARGET.replace(/^http/, 'ws')

// Tailscale's macOS app (sandboxed CLI) writes certs to the container Data dir.
// If present, use them — these are Let's Encrypt certs trusted by all devices.
function tailscaleCert(): { cert: Buffer; key: Buffer } | null {
  const candidates = [
    `${os.homedir()}/Library/Containers/io.tailscale.ipn.macos/Data/${HOSTNAME}`,
    `/var/db/tailscale/certs/${HOSTNAME}`,
    `${process.cwd()}/${HOSTNAME}`,
  ]
  for (const base of candidates) {
    try {
      return { cert: fs.readFileSync(`${base}.crt`), key: fs.readFileSync(`${base}.key`) }
    } catch { /* not found */ }
  }
  return null
}

const tsCert = tailscaleCert()
if (tsCert) {
  console.log('[vite] Using Tailscale HTTPS cert — trusted on all Tailscale devices')
} else {
  console.warn('[vite] Tailscale cert not found, using self-signed cert (untrusted on iOS)')
  console.warn(`[vite] Run: tailscale cert ${HOSTNAME}`)
}

// Deno API routes proxied through Vite so the HTTPS page never makes a
// mixed-content HTTP request to the API port directly.
const PROXIED_ROUTES = [
  '/infer',
  '/health',
  '/upload-scan',
  '/upload-summary',
  '/scans',
  '/process-scan',
  '/projects',
  '/worlds',
  '/scan-locations',
  '/sessions',
  '/jobs',
  '/client-logs',
]

const proxy: Record<string, object> = {}
for (const route of PROXIED_ROUTES) {
  proxy[route] = {
    target: API_TARGET,
    changeOrigin: true,
    secure: false,
    configure: (p: { on: (ev: string, cb: (err: Error) => void) => void }) => {
      p.on('error', (err) => console.error(`[vite-proxy-error ${route}]`, err))
    },
  }
}
for (const route of ['/rtc-signal', '/events']) {
  proxy[route] = {
    target: WS_TARGET,
    ws: true,
    changeOrigin: true,
    secure: false,
    configure: (p: { on: (ev: string, cb: (err: Error) => void) => void }) => {
      p.on('error', (err) => console.error(`[vite-proxy-error ${route} ws]`, err))
    },
  }
}

export default defineConfig({
  plugins: tsCert ? [] : [basicSsl()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(process.cwd(), 'index.html'),
        scanner: path.resolve(process.cwd(), 'scanner.html'),
        viewer: path.resolve(process.cwd(), 'viewer.html'),
        webxr: path.resolve(process.cwd(), 'webxr.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: tsCert ?? true,
    allowedHosts: [HOSTNAME],
    // Tell HMR client to use the Tailscale hostname so iPhones can reach the
    // WebSocket. Without this, Vite falls back to localhost which is unreachable
    // on the device. Port is left unset so it tracks whatever port Vite starts on
    // (5173, or the next free port if 5173 is busy).
    hmr: { host: HOSTNAME },
    proxy,
  },
  // `vite preview` (production bundle) inherits server.https/proxy/host; pin the
  // port so the systemd unit and phones always find it at :5173.
  preview: {
    port: 5173,
    strictPort: true,
    allowedHosts: [HOSTNAME],
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
})
