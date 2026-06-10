import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOSTNAME = 'liambook.capybara-ulmer.ts.net'

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

export default defineConfig({
  plugins: tsCert ? [] : [basicSsl()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(process.cwd(), 'index.html'),
        viewer: path.resolve(process.cwd(), 'viewer.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: tsCert ?? true,
    // Tell HMR client to use the Tailscale hostname so iPhones can reach the
    // WebSocket. Without this, Vite falls back to localhost which is unreachable
    // on the device. Port is left unset so it tracks whatever port Vite starts on
    // (5173, or the next free port if 5173 is busy).
    hmr: { host: HOSTNAME },
    // Proxy the Deno inference server through Vite so the HTTPS page never
    // makes a mixed-content HTTP request to :8000 directly.
    proxy: {
      '/infer': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
      '/upload-scan': 'http://localhost:8000',
      '/upload-summary': 'http://localhost:8000',
      '/scans': 'http://localhost:8000',
      '/process-scan': 'http://localhost:8000',
      '/projects': 'http://localhost:8000',
      '/scan-locations': 'http://localhost:8000',
      '/rtc-signal': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
})
