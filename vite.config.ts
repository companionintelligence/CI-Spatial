import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FALLBACK_HOSTNAME = 'liambook.capybara-ulmer.ts.net'
const PROXY_PATHS = [
  '/infer',
  '/health',
  '/upload-scan',
  '/upload-summary',
  '/client-logs',
  '/scans',
  '/process-scan',
  '/projects',
  '/worlds',
  '/scan-locations',
  '/sessions',
  '/jobs',
]
const WS_PROXY_PATHS = ['/rtc-signal', '/events']

function normalizeHostname(value: string): string {
  return value.trim().replace(/\.$/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

function hostnameFromEnv(): { hostname: string; source: string } | null {
  const raw = process.env.TAILSCALE_HOSTNAME
  if (!raw) return null
  const hostname = normalizeHostname(raw)
  return hostname ? { hostname, source: 'TAILSCALE_HOSTNAME' } : null
}

function hostnameFromTailscaleStatus(): { hostname: string; source: string } | null {
  const candidates = [
    { bin: 'tailscale', source: 'tailscale status --json' },
    { bin: '/Applications/Tailscale.app/Contents/MacOS/Tailscale', source: 'Tailscale.app status --json' },
  ]
  for (const candidate of candidates) {
    try {
      const out = execFileSync(candidate.bin, ['status', '--json'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const data = JSON.parse(out) as { Self?: { DNSName?: string } }
      const hostname = normalizeHostname(data.Self?.DNSName ?? '')
      if (hostname) return { hostname, source: candidate.source }
    } catch {
      // tailscale may be absent or not logged in on developer machines
    }
  }
  return null
}

function hostnameFromLocalCert(): { hostname: string; source: string } | null {
  try {
    const cert = fs.readdirSync(process.cwd()).find((name) => name.endsWith('.ts.net.crt'))
    if (!cert) return null
    return { hostname: cert.replace(/\.crt$/, ''), source: 'local *.ts.net.crt' }
  } catch {
    return null
  }
}

function resolveHostname(): { hostname: string; source: string } {
  return hostnameFromEnv()
    ?? hostnameFromTailscaleStatus()
    ?? hostnameFromLocalCert()
    ?? { hostname: FALLBACK_HOSTNAME, source: 'default' }
}

function wsTargetFor(httpTarget: string): string {
  try {
    const url = new URL(httpTarget)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString().replace(/\/$/, '')
  } catch {
    return 'ws://localhost:8000'
  }
}

const { hostname: HOSTNAME, source: HOSTNAME_SOURCE } = resolveHostname()
const API_TARGET = process.env.API_TARGET ?? 'http://localhost:8000'
const WS_TARGET = process.env.WS_TARGET ?? wsTargetFor(API_TARGET)

console.log(`[vite] Tailnet hostname: ${HOSTNAME} (${HOSTNAME_SOURCE})`)
console.log(`[vite] Proxy target: ${API_TARGET} (ws: ${WS_TARGET})`)

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

const proxy = Object.fromEntries([
  ...PROXY_PATHS.map((route) => [route, {
    target: API_TARGET,
    changeOrigin: true,
    secure: false,
    configure: (proxy) => {
      proxy.on('error', (err) => console.error(`[vite-proxy-error ${route}]`, err))
    },
  }]),
  ...WS_PROXY_PATHS.map((route) => [route, {
    target: WS_TARGET,
    ws: true,
    changeOrigin: true,
    secure: false,
    configure: (proxy) => {
      proxy.on('error', (err) => console.error(`[vite-proxy-error ${route} ws]`, err))
    },
  }]),
])

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
    allowedHosts: [HOSTNAME],
    https: tsCert ?? true,
    // Tell HMR client to use the Tailscale hostname so iPhones can reach the
    // WebSocket. Without this, Vite falls back to localhost which is unreachable
    // on the device. Port is left unset so it tracks whatever port Vite starts on
    // (5173, or the next free port if 5173 is busy).
    hmr: { host: HOSTNAME },
    // Proxy the Deno inference server through Vite so the HTTPS page never
    // makes a mixed-content HTTP request to :8000 directly.
    proxy,
  },
  preview: {
    host: '0.0.0.0',
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
