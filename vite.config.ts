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
        scanner: path.resolve(process.cwd(), 'scanner.html'),
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
      '/infer': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[vite-proxy-error /infer]', err))
        }
      },
      '/health': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[vite-proxy-error /health]', err))
        }
      },
      '/upload-scan': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[vite-proxy-error /upload-scan]', err))
        }
      },
      '/upload-summary': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[vite-proxy-error /upload-summary]', err))
        }
      },
      '/scans': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[vite-proxy-error /scans]', err))
        }
      },
      '/process-scan': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[vite-proxy-error /process-scan]', err))
        }
      },
      '/projects': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[vite-proxy-error /projects]', err))
        }
      },
      '/worlds': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[vite-proxy-error /worlds]', err))
        }
      },
      '/scan-locations': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[vite-proxy-error /scan-locations]', err))
        }
      },
      '/rtc-signal': {
        target: 'ws://localhost:8000',
        ws: true,
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[vite-proxy-error ws]', err))
        }
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
