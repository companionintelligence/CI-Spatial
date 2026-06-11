/**
 * Seeds the running server with the generated test homes so the World Scan
 * Editor has realistic multi-room data to edit.
 *
 *   npm run gen:test-data                              # once
 *   npm run server                                     # in another terminal
 *   node scripts/seed-test-homes.mjs                   # all 24 homes
 *   COUNT=6 node scripts/seed-test-homes.mjs           # first N only
 *   SERVER_URL=http://localhost:8098 node scripts/seed-test-homes.mjs
 *
 * Each upload auto-enqueues the optimization job (quantize/Draco/LODs), so
 * after seeding the editor demonstrates progressive LOD-first loading.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const homesDir = join(root, 'test-data', 'homes')
const SERVER = process.env.SERVER_URL ?? 'http://localhost:8000'
const COUNT = Number(process.env.COUNT ?? Infinity)

if (!existsSync(join(homesDir, 'index.json'))) {
  console.error('[seed] test-data missing — run: npm run gen:test-data')
  process.exit(1)
}

const health = await fetch(`${SERVER}/health`).then((r) => r.json()).catch(() => null)
if (!health) {
  console.error(`[seed] server unreachable at ${SERVER} — start it with npm run server`)
  process.exit(1)
}

const index = JSON.parse(readFileSync(join(homesDir, 'index.json'), 'utf8'))
const selected = index.slice(0, COUNT)

let ok = 0
for (const entry of selected) {
  const form = new FormData()
  const glb = readFileSync(join(homesDir, entry.file))
  form.append('file', new Blob([glb], { type: 'model/gltf-binary' }), entry.file)
  form.append('metadata', readFileSync(join(homesDir, entry.meta), 'utf8'))
  const resp = await fetch(`${SERVER}/upload-scan`, { method: 'POST', body: form })
  if (resp.ok) {
    const body = await resp.json()
    console.log(`  ✓ ${entry.file} → ${body.filename} (job ${body.job})`)
    ok++
  } else {
    console.error(`  ✗ ${entry.file}: HTTP ${resp.status}`)
  }
}

console.log(`\n[seed] ${ok}/${selected.length} homes uploaded to ${SERVER}`)
console.log('[seed] open /viewer.html?world=default to edit them (jobs optimize in the background)')
