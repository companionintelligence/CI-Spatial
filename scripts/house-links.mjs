#!/usr/bin/env node
/**
 * house-links.mjs — print the links + box-side commands for a house-validation
 * session on beta-1, so the operator can walk out of the door with a laptop and
 * an iPhone and reach every surface they need.
 *
 * Reads the world file (arg or $WORLD_FILE, default worlds/default.json) and
 * emits a markdown table of:
 *   - role-tokenized scanner + viewer links (one per non-revoked member),
 *   - tokenless scanner/viewer/smoke/webxr/health URLs (open when
 *     WORLD_STRICT_AUTH is off, which is the box default).
 * Plus a second table of box-side commands (logs, journal, GPU).
 *
 * The token lives in the URL query param `token`; the world's shareSlug (usually
 * "default") is the `world` param. Link shape:
 *   <base>/viewer.html?world=<slug>&token=<T>
 *   <base>/scanner.html?world=<slug>&token=<T>
 *
 * Hostname resolution mirrors qr.mjs / vite.config.ts (first hit wins):
 *   1. TAILSCALE_HOSTNAME / VITE_HOSTNAME env var
 *   2. `tailscale status --json` → Self.DNSName
 *   3. beta-1.capybara-ulmer.ts.net (the box's own tailnet name)
 *
 * Usage:
 *   node scripts/house-links.mjs [world-file]      # markdown tables
 *   node scripts/house-links.mjs --qr scanner      # terminal QR for a role's
 *                                                  # scanner link (or: viewer,
 *                                                  # editor, owner; or a bare
 *                                                  # URL kind: smoke/webxr/health)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import qrcode from 'qrcode-terminal'

const VITE_PORT = 5173
const DEFAULT_HOSTNAME = 'beta-1.capybara-ulmer.ts.net'
const ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_WORLD_FILE = path.join(ROOT, 'worlds', 'default.json')

function parseArgv(argv) {
  const out = { worldFile: null, qr: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--qr') {
      out.qr = argv[++i] ?? 'scanner'
    } else if (!a.startsWith('--')) {
      out.worldFile = a
    }
  }
  return out
}

function resolveHostname() {
  const fromEnv = process.env.TAILSCALE_HOSTNAME ?? process.env.VITE_HOSTNAME
  if (fromEnv) return { hostname: fromEnv, source: 'env' }

  const bins = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
  for (const bin of bins) {
    try {
      const out = execFileSync(bin, ['status', '--json'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      const dns = JSON.parse(out.toString())?.Self?.DNSName
      if (typeof dns === 'string' && dns.length > 0) {
        return { hostname: dns.replace(/\.$/, ''), source: 'tailscale cli' }
      }
    } catch { /* not installed / not running — try next */ }
  }
  return { hostname: DEFAULT_HOSTNAME, source: 'default' }
}

function loadWorld(worldFile) {
  let raw
  try {
    raw = readFileSync(worldFile, 'utf8')
  } catch (err) {
    console.error(`error: cannot read world file ${worldFile}: ${err.message}`)
    process.exit(1)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    console.error(`error: world file ${worldFile} is not valid JSON: ${err.message}`)
    process.exit(1)
  }
}

/** role → token, skipping revoked members (first non-revoked wins per role). */
function tokensByRole(world) {
  const map = new Map()
  for (const m of world.members ?? []) {
    if (m.revokedAt) continue
    if (!map.has(m.role)) map.set(m.role, m.token)
  }
  return map
}

function roleLink(base, page, slug, token) {
  return `${base}/${page}?world=${slug}&token=${encodeURIComponent(token)}`
}

/**
 * Resolve the URL for a --qr selector: a role name (scanner/viewer/editor/owner
 * → that role's scanner link, since QR is for walking in with a phone) or a
 * bare page kind (smoke/webxr/health/scanner/viewer without a token).
 */
function urlForSelector(selector, ctx) {
  const { base, slug, byRole } = ctx
  const ROLES = ['owner', 'editor', 'viewer', 'scanner']
  if (ROLES.includes(selector)) {
    const token = byRole.get(selector)
    if (!token) {
      console.error(`error: world has no active '${selector}' member`)
      process.exit(1)
    }
    // Scanner is what you point a phone at to capture; that's the QR intent.
    return roleLink(base, 'scanner.html', slug, token)
  }
  const tokenless = {
    smoke: `${base}/smoke.html`,
    webxr: `${base}/webxr.html`,
    health: `${base.replace(`:${VITE_PORT}`, ':8000')}/health`,
    'scanner-open': `${base}/scanner.html?world=${slug}`,
    'viewer-open': `${base}/viewer.html?world=${slug}`,
  }
  if (tokenless[selector]) return tokenless[selector]
  console.error(`error: unknown --qr selector '${selector}' (roles: ${ROLES.join('/')}; kinds: smoke/webxr/health/scanner-open/viewer-open)`)
  process.exit(1)
}

function main() {
  const { worldFile, qr } = parseArgv(process.argv.slice(2))
  const file = worldFile ?? process.env.WORLD_FILE ?? DEFAULT_WORLD_FILE
  const world = loadWorld(file)
  const slug = world.shareSlug ?? 'default'
  const { hostname, source } = resolveHostname()
  const base = `https://${hostname}:${VITE_PORT}`
  const apiBase = `https://${hostname}:8000`
  const byRole = tokensByRole(world)

  if (qr) {
    const url = urlForSelector(qr, { base, slug, byRole })
    console.log(`\n${url}   (hostname via ${source})\n`)
    qrcode.generate(url, { small: true })
    return
  }

  const ROLES = ['owner', 'editor', 'viewer', 'scanner']
  console.log(`# House-validation links — world "${slug}"`)
  console.log(`\nWorld file: \`${file}\``)
  console.log(`Host: \`${hostname}\` (via ${source})\n`)

  console.log('## Role links (tokenized — treat as secrets)\n')
  console.log('| Role | Scanner (capture) | Viewer (review) |')
  console.log('|------|-------------------|-----------------|')
  for (const role of ROLES) {
    const token = byRole.get(role)
    if (!token) {
      console.log(`| ${role} | _(no active member)_ | _(no active member)_ |`)
      continue
    }
    const scan = roleLink(base, 'scanner.html', slug, token)
    const view = roleLink(base, 'viewer.html', slug, token)
    console.log(`| ${role} | ${scan} | ${view} |`)
  }

  console.log('\n## Open URLs (no token — work when WORLD_STRICT_AUTH is off, the box default)\n')
  console.log('| Purpose | URL |')
  console.log('|---------|-----|')
  console.log(`| Scanner | ${base}/scanner.html?world=${slug} |`)
  console.log(`| Viewer | ${base}/viewer.html?world=${slug} |`)
  console.log(`| Smoke test | ${base}/smoke.html |`)
  console.log(`| WebXR | ${base}/webxr.html |`)
  console.log(`| Server health | ${apiBase}/health |`)

  console.log('\n## Box-side commands (run on beta-1 over SSH)\n')
  console.log('| What | Command |')
  console.log('|------|---------|')
  console.log('| Tail server logs (dev) | `npm run logs:watch` |')
  console.log('| Tail server logs (service) | `journalctl --user -u cscan-server -f` |')
  console.log('| GPU utilisation | `rocm-smi` |')
  console.log('')
  console.log('Tip: `node scripts/house-links.mjs --qr scanner` prints a phone-scannable QR for the scanner link.')
}

main()
