// Temporary HTTP-only override so a browser that refuses self-signed certs can
// load the editor. The Tailscale cert exists but macOS sandboxes it out of
// reach (Operation not permitted on the container Data dir), so vite.config's
// `https: tsCert ?? true` falls through to a self-signed cert. Not for devices.
import base from './vite.config.ts'

const cfg = base as unknown as Record<string, unknown>
const server = (cfg.server ?? {}) as Record<string, unknown>
export default {
  ...cfg,
  server: { ...server, https: false, port: 5199, strictPort: true, hmr: false },
}
