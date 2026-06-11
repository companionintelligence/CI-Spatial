/**
 * Copies the three.js Draco decoder (wasm + JS glue) into public/draco/ so
 * the viewer's DRACOLoader can decode Draco-compressed scan artifacts offline.
 * Runs automatically via the `postinstall` npm hook.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf')
const target = join(root, 'public', 'draco')

if (!existsSync(source)) {
  console.warn('[copy-draco] three.js draco decoder not found — run npm install first')
  process.exit(0)
}

mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })
console.log(`[copy-draco] decoder copied to public/draco/`)
