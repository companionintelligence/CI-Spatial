#!/usr/bin/env node
/**
 * qr.mjs — print a scannable terminal QR code for a page on the dev server.
 *
 * Usage:
 *   npm run qr                                   # QR for /
 *   npm run qr -- "/scanner.html?world=default"  # QR for a specific path
 *
 * Hostname resolution mirrors vite.config.ts (first hit wins):
 *   1. TAILSCALE_HOSTNAME / VITE_HOSTNAME env var
 *   2. `tailscale status --json` → Self.DNSName
 *   3. localhost (QR only useful on this machine)
 */
import { execFileSync } from 'node:child_process'
import qrcode from 'qrcode-terminal'

const PORT = process.env.VITE_PORT ?? 5173

function resolveHostname() {
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

  return { hostname: 'localhost', source: 'fallback — phones cannot reach this' }
}

const rawPath = process.argv[2] ?? '/'
const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
const { hostname, source } = resolveHostname()
const url = `https://${hostname}:${PORT}${path}`

console.log(`\n${url}   (hostname via ${source})\n`)
qrcode.generate(url, { small: true })
