#!/usr/bin/env node
/**
 * Checks that the Niantic Spatial XR Engine files are byte for byte the ones Niantic publishes:
 * `node scripts/native/check-xr-engine.mjs [dir]`, where `dir` holds xr.js and resources/ at its
 * top (public/ by default; mobile/www, or the APK's assets/public, after a build).
 *
 * The XR Engine License Agreement (section 1.1) allows distributing the engine only "in the
 * original form distributed by Niantic Spatial". The hashes below are those of
 * @8thwall/engine-binary 1.0.0 as jsDelivr serves it (dist/), which the committed files match. A
 * Windows checkout with core.autocrlf=true used to rewrite the three .js files (.gitattributes now
 * stops that), and this is what notices. Exits 1, naming each file that differs or is missing.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The engine version these hashes belong to. */
export const ENGINE_PACKAGE = '@8thwall/engine-binary@1.0.0'

/** sha256 of each engine file, from the published package. */
export const ENGINE_SHA256 = {
  'xr.js': 'b3973936862f4cb77ae32d24f253d8a0e8b1de4fa2a0cf688833742889ee829d',
  'xr-slam.js': '398f675c920892afd4521d5196df2b6b8a1b8a90b6a5c749cf5ad1a6e0a85270',
  'xr-face.js': '43b3966b709871bf64216d31983e472693f21d1846bc5c52d014c0e132dc3a65',
  'resources/dom-tablet-button.glb': '69bb197329b5382906360a58e8a00995dae958667dbe93b002cb51068bfefda6',
  'resources/dom-tablet-frame.glb': 'ceb73d8655c544b8fe0c60fdf7de9a6c5e20ed9410e5c412f325b183360ed9ed',
  'resources/face-ear-model.tflite': '4cd07c3ecc4ac3a19097ad5d8e2920113e8786d29302e48064b5e21b9f828552',
  'resources/face-mesh-model.tflite': '97cd5b1d16d1d205445134d0d8882a619068c1a49277652c468049d0fc7f2756',
  'resources/face-model.tflite': '0d800dd37230bb0503e2bc84ce547a1328dc0e2d8c54a5a92df953710decc4ed',
  'resources/media-worker.js': 'db47c89ca2ec7d9eba75e114c195896c74c7b0ff888ce2970dfd9bd8bdfeda8d',
  'resources/powered-by.svg': '4c8bf13771807ac55c963fc08421f611e6e1ab37d5410dc0bbf049f94bea0797',
  'resources/semantics-model.tflite': 'b25bebe3ec1b7390feec937d1e4eafb3d6f2104d584a738c0bdf6486030b70a0',
  'resources/semantics-worker.js': '7db219a04051354c20d0fbe16333236ba0b49054fbe985a334b49817032da45e',
}

/** The engine files in `dir` that are missing or not Niantic's bytes, as `[file, problem]` pairs. */
export function engineProblems(dir) {
  const problems = []
  for (const [file, expected] of Object.entries(ENGINE_SHA256)) {
    const path = join(dir, file)
    if (!existsSync(path)) {
      problems.push([file, 'missing'])
      continue
    }
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (actual !== expected) problems.push([file, `sha256 ${actual}, expected ${expected}`])
  }
  return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const dir = resolve(process.argv[2] ?? join(root, 'public'))
  const problems = engineProblems(dir)
  if (problems.length) {
    for (const [file, problem] of problems) console.error(`${file}: ${problem}`)
    console.error(`The XR Engine in ${dir} is not ${ENGINE_PACKAGE} as published. A checkout that converted line endings is the usual cause: `
      + 'delete public/xr*.js and run `git checkout -- public` (.gitattributes keeps them unconverted).')
    process.exit(1)
  }
  console.log(`XR Engine in ${dir}: all ${Object.keys(ENGINE_SHA256).length} files match ${ENGINE_PACKAGE}`)
}
