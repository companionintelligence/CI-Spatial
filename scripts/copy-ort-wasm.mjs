/**
 * Copies onnxruntime-web's WebGPU/JSEP WASM runtime (binary + JS glue) into
 * public/ort/ so wave 05's on-device inference worker
 * (src/inference/webgpu.worker.ts) loads it from this origin instead of
 * falling through to onnxruntime-web's default remote asset resolution —
 * see docs/factory/05-on-device-inference/0003-webgpu-driver-runtime.md's
 * Definition of Done: "WASM/JSEP assets are served locally, with no
 * third-party request." Mirrors scripts/copy-draco.mjs's pattern for the
 * identical problem (a WASM runtime a bundled npm package ships as a binary
 * asset Vite can't just inline). Runs automatically via the `postinstall`
 * npm hook.
 *
 * NOT the same build as the ort-wasm-simd-threaded.jsep-*.wasm that already
 * lands in dist/assets/ from @huggingface/transformers's own bundled
 * onnxruntime-web — that dependency floats on a 1.22.0-dev prerelease,
 * while this ticket deliberately pins onnxruntime-web to onnxruntime-node's
 * 1.21.x major (ticket 0003's Pinned Conventions), so the .mjs glue this
 * worker configures and the .wasm binary it loads must come from the same
 * install. Copying node_modules/onnxruntime-web/dist/ directly, rather than
 * reusing the other copy, is what keeps that pairing honest.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules', 'onnxruntime-web', 'dist')
const target = join(root, 'public', 'ort')

if (!existsSync(source)) {
  console.warn('[copy-ort-wasm] onnxruntime-web not found — run npm install first')
  process.exit(0)
}

// The JSEP pair is what the WebGPU/WebNN execution provider loads; the
// plain pair is onnxruntime-web's own CPU/wasm fallback for ops the WebGPU
// backend doesn't implement. Copying both means whichever one
// ort.webgpu.mjs resolves at runtime is already local — no per-op surprise
// third-party fetch.
const FILES = [
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
]

mkdirSync(target, { recursive: true })
let copied = 0
for (const file of FILES) {
  const from = join(source, file)
  if (!existsSync(from)) {
    console.warn(`[copy-ort-wasm] missing ${file} in onnxruntime-web/dist — skipping`)
    continue
  }
  cpSync(from, join(target, file))
  copied++
}
console.log(`[copy-ort-wasm] ${copied}/${FILES.length} onnxruntime-web WASM runtime files copied to public/ort/`)
