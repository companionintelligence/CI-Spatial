/**
 * Normalizes OLLAMA_HOST into a URL Ollama's HTTP API can actually be
 * reached at. OLLAMA_HOST is documented (.env.example) to accept either a
 * full URL ('http://localhost:11434') or a bare bind address
 * ('0.0.0.0:11434', as Ollama's own server config uses) — the latter isn't
 * fetchable as-is (0.0.0.0 means "every interface" to a server, not a real
 * destination for a client), so this rewrites it to 127.0.0.1.
 *
 * Runtime-agnostic: imported by Deno server code (inference.ts) and by Node
 * scripts (scripts/bench-models.mjs, scripts/setup-models.mjs) alike,
 * following the src/shared/ precedent. Previously a local, unexported
 * function inside inference.ts — bench-models.mjs and setup-models.mjs each
 * talk to Ollama directly, outside the server process, and need the exact
 * same normalization, so this is the ADR 0001 reuse fix, not a rename.
 */

export function normalizeOllamaHost(rawHost: string | undefined): string {
  const raw = rawHost?.trim() || 'http://localhost:11434'
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`

  try {
    const url = new URL(candidate)
    // 0.0.0.0 and :: are server bind addresses, not client destinations.
    if (url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname === '::') {
      url.hostname = '127.0.0.1'
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    throw new Error(`OLLAMA_HOST must be a URL or host:port, received "${raw}"`)
  }
}
