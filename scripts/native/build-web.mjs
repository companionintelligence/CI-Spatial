#!/usr/bin/env node
/**
 * The web build a native shell ships: `node scripts/native/build-web.mjs desktop|mobile`.
 *
 * Both shells bundle the Scan web app rather than loading a page from a server. This is that
 * build, run by desktop/src-tauri/tauri.conf.json (beforeBuildCommand) and mobile/package.json
 * (build:web), the same way on Windows, macOS and Linux:
 *
 *   1. VITE_API_BASE may be unset: the app then asks for the person's Scan server. When it is
 *      set it must be an https origin (mobile/scripts/check-api-base.mjs).
 *   2. No .env file may set a VITE_ variable. Vite would bake it into the bundle, and a native
 *      build must carry no developer's address, key or secret.
 *   3. tsc --noEmit, then vite build with VITE_DISABLE_PWA=1 (no service worker and no manifest,
 *      see pwaSwitch() in vite.config.ts) into desktop/dist or mobile/www.
 *   4. The desktop app is the editor and viewer, with no AR capture, so its bundle leaves out the
 *      8th Wall engine: xr.js, xr-slam.js, xr-face.js and resources/.
 *   5. No app bundles what NATIVE_EXCLUDED lists. public/ is copied whole, and a developer's
 *      public/models (the on-device model weights, whose licence is unchecked) would otherwise
 *      ride along into an installer or an APK.
 *   6. The bundle gets THIRD-PARTY-NOTICES.txt, generated from the lockfiles for exactly what it
 *      contains (scripts/native/third-party-notices.mjs), and LICENSE.txt. The app's Legal notices
 *      view shows both. The same notices go to <shell>/build/third-party-notices.json, which the
 *      release workflow merges into the release asset.
 *   7. The bundle is checked for what must not be in it. The mobile bundle must also carry the XR
 *      Engine exactly as Niantic publishes it (scripts/native/check-xr-engine.mjs): a Windows clone
 *      made before .gitattributes holds converted copies in public/, which the build would ship.
 *      Then its contents are listed.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apiBaseProblem } from '../../mobile/scripts/check-api-base.mjs'
import { ENGINE_PACKAGE, engineProblems } from './check-xr-engine.mjs'
import { bundleNotices, renderNotices, rustTargets } from './third-party-notices.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Where each shell's bundle goes. */
export const OUT_DIRS = { desktop: 'desktop/dist', mobile: 'mobile/www' }

/** Where each shell's notices JSON and module list go: git-ignored build/ folders, never inside the bundle. */
export const BUILD_DIRS = { desktop: 'desktop/build', mobile: 'mobile/build' }

/** The licence files every bundle carries at its root. The Legal notices view reads them. */
export const NOTICE_FILES = ['THIRD-PARTY-NOTICES.txt', 'LICENSE.txt']

/** The AR engine. The desktop bundle leaves it out: the editor and viewer never load it. */
export const ENGINE_FILES = ['xr.js', 'xr-slam.js', 'xr-face.js', 'resources']

/** The PWA files pwaSwitch() removes when VITE_DISABLE_PWA is set. A shell cannot use them. */
export const PWA_FILES = ['sw.js', 'manifest.json']

/**
 * What no app bundle carries, though the web build copies it out of public/ when it is there.
 * Keys are paths in the bundle; values say why.
 */
export const NATIVE_EXCLUDED = {
  'models': 'the LFM2.5-VL-1.6B-ONNX weights download_models.py fetches into public/models (git-ignored, about '
    + '2.2 GB). Their licence (LiquidAI lfm1.0) has not been checked for redistribution, so no app ships them.',
  'real-camera-artifacts': 'screenshots from device test runs, kept for the test docs. They are not app assets, '
    + 'and they show a test machine\'s own address bar.',
  'test-fixtures': 'the XR8 mock and a synthetic test image, used only by automated tests.',
}

/** The .env files `vite build` reads (mode production). */
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local']

/** The VITE_ variables a .env file in `dir` would put into a build: `[file, name]` pairs. */
export function viteVariablesInEnvFiles(dir = ROOT) {
  const found = []
  for (const file of ENV_FILES) {
    const path = join(dir, file)
    if (!existsSync(path)) continue
    for (const match of readFileSync(path, 'utf8').matchAll(/^\s*(?:export\s+)?(VITE_[A-Za-z0-9_]+)\s*=/gm)) {
      found.push([file, match[1]])
    }
  }
  return found
}

/** What a finished bundle must not contain, as relative paths that exist in it. */
export function forbiddenInBundle(outDir, shell) {
  const names = [...PWA_FILES, ...Object.keys(NATIVE_EXCLUDED), ...(shell === 'desktop' ? ENGINE_FILES : [])]
  return names.filter((name) => existsSync(join(outDir, name)))
}

/**
 * The XR Engine files in a finished bundle that are missing or not Niantic's published bytes, as
 * `[file, problem]` pairs. Only the mobile app carries the engine; the desktop bundle has none.
 */
export function engineProblemsInBundle(outDir, shell) {
  return shell === 'mobile' ? engineProblems(outDir) : []
}

function sizeOf(path) {
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.size
  return readdirSync(path).reduce((total, entry) => total + sizeOf(join(path, entry)), 0)
}

function fail(message) {
  console.error(`[native web build] ${message}`)
  process.exit(1)
}

function node(script, args, env) {
  const run = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (run.status !== 0) fail(`${script} ${args.join(' ')} exited with ${run.status}`)
}

export function buildShellWeb(shell) {
  const outRel = OUT_DIRS[shell]
  if (!outRel) fail(`unknown shell "${shell}": use one of ${Object.keys(OUT_DIRS).join(', ')}`)
  const outDir = join(ROOT, outRel)

  const problem = apiBaseProblem(process.env.VITE_API_BASE)
  if (problem) fail(problem)
  const baked = viteVariablesInEnvFiles()
  if (baked.length) {
    fail(`refusing to build: ${baked.map(([file, name]) => `${file} sets ${name}`).join(', ')}. `
      + 'A native build must not carry local settings. Move them out of the .env file, or set them in the environment for this build.')
  }

  if (shell === 'mobile' && !existsSync(join(ROOT, 'mobile', 'node_modules', '@capacitor', 'android'))) {
    fail('mobile/node_modules is missing: run npm ci --prefix mobile first. The notices list its Android runtime.')
  }
  const buildDir = join(ROOT, BUILD_DIRS[shell])
  mkdirSync(buildDir, { recursive: true })
  const report = join(buildDir, 'bundle-modules.json')
  rmSync(report, { force: true })

  node('node_modules/typescript/bin/tsc', ['--noEmit'])
  node('node_modules/vite/bin/vite.js', ['build', '--outDir', outRel, '--emptyOutDir'], {
    VITE_DISABLE_PWA: '1',
    NATIVE_BUNDLE_REPORT: report,
  })

  for (const [name, why] of Object.entries(NATIVE_EXCLUDED)) {
    if (!existsSync(join(outDir, name))) continue
    rmSync(join(outDir, name), { recursive: true, force: true })
    console.warn(`[native web build] left out ${name}/: ${why}`)
  }
  if (shell === 'desktop') {
    for (const name of ENGINE_FILES) rmSync(join(outDir, name), { recursive: true, force: true })
  }
  const left = forbiddenInBundle(outDir, shell)
  if (left.length) fail(`${outRel} still contains ${left.join(', ')}`)
  const engine = engineProblemsInBundle(outDir, shell)
  if (engine.length) {
    fail(`${outRel} does not carry ${ENGINE_PACKAGE} as Niantic publishes it, and its licence allows no other form: `
      + `${engine.map(([file, problem]) => `${file} (${problem})`).join('; ')}. A checkout that converted line endings `
      + 'is the usual cause: delete public/xr*.js and run `git checkout -- public` (.gitattributes keeps them unconverted).')
  }

  if (!existsSync(report)) fail(`the build wrote no module list to ${report}, so its notices cannot be made`)
  const modules = JSON.parse(readFileSync(report, 'utf8')).modules
  const notices = bundleNotices({ shell, bundledModules: modules, targets: shell === 'desktop' ? rustTargets() : [] })
  const version = JSON.parse(readFileSync(join(ROOT, 'desktop', 'package.json'), 'utf8')).version
  writeFileSync(join(outDir, 'THIRD-PARTY-NOTICES.txt'), renderNotices(notices, version))
  copyFileSync(join(ROOT, 'LICENSE'), join(outDir, 'LICENSE.txt'))
  writeFileSync(join(buildDir, 'third-party-notices.json'), JSON.stringify(notices))
  console.log(`[native web build] notices: ${notices.components.length} components (${notices.titles.join('; ')})`)

  const entries = readdirSync(outDir).sort()
  const total = entries.reduce((sum, entry) => sum + sizeOf(join(outDir, entry)), 0)
  console.log(`[native web build] ${shell}: ${relative(ROOT, outDir)} holds ${entries.length} entries, ${(total / 1e6).toFixed(1)} MB`)
  for (const entry of entries) console.log(`  ${entry}${statSync(join(outDir, entry)).isDirectory() ? '/' : ''} ${(sizeOf(join(outDir, entry)) / 1e3).toFixed(0)} kB`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildShellWeb(process.argv[2])
}
