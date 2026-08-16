/**
 * One-command capture stage for the product video.
 *
 *   node scripts/video-stage.mjs                     # Vite :5173, API :8000
 *   VIDEO_PORT=5182 VIDEO_API_PORT=18182 node scripts/video-stage.mjs
 *
 * Brings up everything `video/` needs to shoot the storyboard and then blocks,
 * so an unattended runner can start it, poll `/health`, capture, and kill it:
 *
 *   1. generates the synthetic test homes (scripts/generate-test-homes.mjs)
 *   2. places the first VIDEO_SCANS of them ADJACENT (see below)
 *   3. starts the Deno API on isolated data dirs, waits for /health
 *   4. seeds those homes into world "default" and waits for the optimize jobs
 *   5. runs Vite in the foreground; SIGINT/SIGTERM tears the API down too
 *
 * ── Why step 2 exists ────────────────────────────────────────────────────────
 * src/shared/test-homes.ts offsets every generated home by 0.0011 deg of
 * latitude — about 122 m. Three six-metre rooms spread over a quarter of a
 * kilometre is what used to fill the World Editor shots with black, and what
 * flung the two off-camera rooms' semantic labels into the top-right corner of
 * the frame, on top of #inspector-panel. Nothing about the product is faked by
 * moving them: the geo pose is fixture data, the viewer's geo->local assembly is
 * untouched, and "every room you scan lands in one 3D world" is then literally
 * what the viewport shows. video/README.md calls this out as the better of the
 * two framing fixes.
 *
 * The rooms are laid out WEST of the auto-selected scan (the newest upload, i.e.
 * the last one seeded). #btn-reset-camera frames that scan, and its neighbours
 * then sit up-and-left inside the canvas. Stepping them east or south instead
 * puts them behind the camera and out of frame — measured, not guessed.
 *
 * ── Why the API is on its own port ───────────────────────────────────────────
 * vite.config.ts proxies /infer, /worlds, /scans, /jobs, … to API_TARGET, so the
 * capture only ever talks to VIDEO_PORT. VIDEO_API_PORT exists so several agents
 * can stage different repos at once without colliding on :8000.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// VIDEO_PORT is intentionally its own isolated staging-port knob, separate from
// the app-wide VITE_PORT (main.ts/vite.config.ts) — don't conflate the two.
const PORT = process.env.VIDEO_PORT ?? '5173'
const API_PORT = process.env.VIDEO_API_PORT ?? '8000'
const SCAN_COUNT = Number(process.env.VIDEO_SCANS ?? 3)
// Isolated data dirs: worlds/default.json is a tracked file and scans/ churn
// under the checkout is what vite.config.ts already guards its watcher against.
const DATA = process.env.VIDEO_DATA_DIR ?? join(tmpdir(), 'ci-video-scan-stage')

const api = `http://localhost:${API_PORT}`
const children = []

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
    p.on('error', reject)
  })
}

function background(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
  children.push(p)
  return p
}

function shutdown(code = 0) {
  for (const p of children) { try { p.kill('SIGTERM') } catch { /* already gone */ } }
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function waitFor(url, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return await r.json()
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`${label} did not come up within ${timeoutMs} ms`)
}

// ── 1. fixtures ──────────────────────────────────────────────────────────────
console.log('[stage] generating test homes')
await run('node', ['scripts/generate-test-homes.mjs'])
await run('node', ['scripts/generate-cv-images.mjs'])

// ── 2. place them adjacent ───────────────────────────────────────────────────
/** GLB basenames, in seed order — chosen in step 2, consumed in step 4. */
let stagedHomes = []
{
  const homesDir = join(root, 'test-data', 'homes')
  const all = JSON.parse(readFileSync(join(homesDir, 'index.json'), 'utf8'))
  // One home per ARCHETYPE, and ROOMS rather than whole dwellings.
  //
  // index.json is ordered archetype-major with variants A/B/C, so `slice(0, 3)`
  // handed the World Editor "Studio Apartment A", "Studio Apartment B" and
  // "Studio Apartment C" — three ±12% rescalings of one room, with near-identical
  // furniture. The whole claim of the World Editor is that separate scans of
  // separate rooms assemble into one world; a scan list of three same-named
  // rooms argues the opposite, and reads like the seeder ran three times by
  // mistake.
  //
  // Deduping on `entry.slug` does NOT fix that, although it reads as if it
  // should: the slug carries the VARIANT as well as the archetype ("studio-a",
  // "studio-b", "studio-c"), so every entry is already distinct and the filter
  // never skips anything — the result was byte-identical to `slice(0, 3)`, which
  // is why the duplicate rooms survived the fix that was meant to remove them.
  // There is no archetype field on the entry; the archetype is the slug with its
  // trailing one-letter variant removed.
  const archetypeOf = (entry) => entry.slug.replace(/-[a-z]$/, '')

  // The storyboard's line over these shots is "Every room you scan lands in one
  // 3D world", so the seeded homes are rooms of one house — a living room, a
  // kitchen and a home office. Deduping by archetype alone would take the first
  // three archetypes in the file (a studio apartment, a one-bedroom and a living
  // room), which mixes whole dwellings with rooms inside one and argues for a
  // neighbourhood rather than a home. Still fixture data, still deterministic,
  // but now shaped like the claim the narration makes.
  const PREFERRED = ['living-room', 'kitchen', 'office']

  const firstOfArchetype = new Map()
  for (const entry of all) {
    const archetype = archetypeOf(entry)
    if (!firstOfArchetype.has(archetype)) firstOfArchetype.set(archetype, entry)
  }

  const index = []
  const taken = new Set()
  const take = (entry) => {
    if (!entry || taken.has(entry.slug) || index.length >= SCAN_COUNT) return
    taken.add(entry.slug)
    index.push(entry)
  }
  for (const archetype of PREFERRED) take(firstOfArchetype.get(archetype))
  // Degrade to a DIFFERENT archetype, never to another variant of one already
  // taken, if the fixture set is renamed or VIDEO_SCANS asks for more rooms.
  for (const entry of firstOfArchetype.values()) take(entry)
  // Last resort only: fewer archetypes exist than SCAN_COUNT wants.
  for (const entry of all) take(entry)
  // ~8.8 m of longitude per step at this latitude: three rooms in a row, not
  // three addresses in a neighbourhood.
  const STEP_LNG = 0.0001
  const first = JSON.parse(readFileSync(join(homesDir, index[0].meta), 'utf8'))
  const baseLat = first.geoLat
  const baseLng = first.geoLng
  index.forEach((entry, i) => {
    const file = join(homesDir, entry.meta)
    const meta = JSON.parse(readFileSync(file, 'utf8'))
    meta.geoLat = baseLat
    meta.geoLng = Math.round((baseLng + i * STEP_LNG) * 1e6) / 1e6
    writeFileSync(file, JSON.stringify(meta, null, 2))
  })
  stagedHomes = index.map((entry) => entry.file.replace(/\.glb$/, ''))
  console.log(
    `[stage] ${index.length} homes placed ${Math.round(STEP_LNG * 111_320 * Math.cos(baseLat * Math.PI / 180))} m apart`
    + `: ${index.map((e) => e.name).join(', ')}`,
  )
}

// ── 3. API ───────────────────────────────────────────────────────────────────
rmSync(DATA, { recursive: true, force: true })
for (const d of ['scans', 'worlds', 'summaries']) mkdirSync(join(DATA, d), { recursive: true })

console.log(`[stage] starting API on ${api} (data: ${DATA})`)
background('deno', [
  'run', '--allow-net', '--allow-read', '--allow-write', '--allow-env', '--allow-ffi', '--allow-run', 'main.ts',
], {
  // The colour-blob engine: no model download, no GPU, and it recognises the
  // same palette the xr8 camera mock paints, so /infer is deterministic.
  INFERENCE_MODE: 'mock',
  PORT: API_PORT,
  TAILSCALE_HOSTNAME: 'localhost',
  SCANS_DIR: join(DATA, 'scans'),
  WORLDS_DIR: join(DATA, 'worlds'),
  SUMMARIES_DIR: join(DATA, 'summaries'),
})
await waitFor(`${api}/health`, 'Deno API')

// ── 4. seed ──────────────────────────────────────────────────────────────────
console.log(`[stage] seeding ${SCAN_COUNT} homes`)
await run('node', ['scripts/seed-test-homes.mjs'], {
  env: { ...process.env, SERVER_URL: api, COUNT: String(SCAN_COUNT), HOMES: stagedHomes.join(',') },
})
// Every viewer shot waits on "Ready - optimized", which is only set once the
// full-quality GLB is in the scene. Block here so a capture cannot start against
// a half-optimized world.
{
  const deadline = Date.now() + 120_000
  for (;;) {
    const jobs = await fetch(`${api}/jobs`).then((r) => r.json()).catch(() => [])
    const list = Array.isArray(jobs) ? jobs : (jobs.jobs ?? [])
    const optimize = list.filter((j) => j.type === 'optimize-scan')
    if (optimize.length >= SCAN_COUNT && optimize.every((j) => j.status === 'done')) break
    if (optimize.some((j) => j.status === 'error' || j.status === 'failed')) {
      throw new Error('an optimize-scan job failed — the World Editor shots would film a half-loaded world')
    }
    if (Date.now() > deadline) throw new Error('optimize jobs did not finish within 120 s')
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log('[stage] all scans optimized')
}

// ── 5. app ───────────────────────────────────────────────────────────────────
// --strictPort: Vite silently walks to the next free port otherwise, which would
// leave the capture pointed at a dead one.
// TAILSCALE_HOSTNAME: vite.config.ts pins server.allowedHosts to a Tailscale
// name, and without the override Vite rejects a localhost Host header outright —
// every shot captures a blocked-request page instead of the app.
console.log(`[stage] starting Vite on https://localhost:${PORT}`)
const vite = background('node', ['node_modules/vite/bin/vite.js', '--port', PORT, '--strictPort', '--host'], {
  TAILSCALE_HOSTNAME: 'localhost',
  API_TARGET: api,
})
vite.on('exit', (code) => shutdown(code ?? 0))
