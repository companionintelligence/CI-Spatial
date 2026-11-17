/**
 * Docs and config that state what the code owns: the origins the server admits, the job deadlines,
 * the torch devices, what Vite does with a .env file, the ARCore terms and disclosure, and the device
 * kit's contract with the shell builds.
 *
 * Three lines of work were merged by hand, and the prose they each wrote was true for its own tree.
 * In the combined tree it named two shell origins where the server admits five, said a Place export
 * was a placeholder after it was built, left ten deadline variables out of .env.example, and listed
 * ARCore nowhere though the Android app now carries it. These tests hold that prose to the code, so the
 * next merge cannot leave it behind quietly. Each one reads the code's own value, not a copy of it.
 *
 * Two of them go further than reading the repo. The Vite one runs a real `vite build` on a scratch
 * project, because what Vite does with a .env file is Vite's fact, and a review caught this repo's docs
 * stating the opposite of it. The ARCore one holds the disclosure to the sentence on Google's own page,
 * which no test here can fetch: it is copied below with the page it came from, so the next person to
 * change a word has the page to check it against.
 *
 * Runs with `npm run test:wave` (the wp- prefix), or alone:
 *   node --experimental-strip-types --no-warnings --test tests/unit/node/wp-docs-config-honesty.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiBaseProblem } from '../../../mobile/scripts/check-api-base.mjs'
import { ANDROID_SHELL_ORIGIN, DESKTOP_SHELL_ORIGINS, NATIVE_SHELL_ORIGIN, isAllowedOrigin } from '../../../server/origin.ts'
import { COMPUTE_DEVICES } from '../../../src/world/manifests.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/** Every .ts file under `dir`, as a path from the repo root. */
function tsFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...tsFiles(path))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

/** What an arithmetic default such as `3 * 60 * 60 * 1000` or `15_000` comes to. */
function evaluate(expression: string): number {
  const plain = expression.replace(/\/\/.*$/, '').replace(/;\s*$/, '').trim()
  assert.match(plain, /^[0-9_*+\-/ ()]+$/, `not a plain number: ${expression}`)
  return Function(`'use strict'; return (${plain.replaceAll('_', '')})`)() as number
}

/** The value `.env.example` shows for a commented-out `#NAME=value` line, or null when it has none. */
function exampleValue(example: string, name: string): string | null {
  return example.match(new RegExp(`^#${name}=(.*)$`, 'm'))?.[1].trim() ?? null
}

/** Folders that hold dependencies, build output or dated history rather than the prose and code of the product. */
const NOT_PRODUCT = new Set(['node_modules', '.git', 'dist', 'www', 'build', 'Pods', '.gradle', 'target', 'test-results', 'audits'])

/**
 * The text files, as paths from the repo root, in which the product says something to a person: its source,
 * scripts, docs, workflows and the shells' folders, plus the files at the root. Tests are left out, since they
 * quote what a doc must not say. Dated audits are history and left out too.
 */
function proseAndSourceFiles(): string[] {
  const found: string[] = []
  const visit = (dir: string, recurse: boolean) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = dir === '.' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (recurse && !NOT_PRODUCT.has(entry.name)) visit(path, true)
      } else if (/\.(md|ts|mjs|js|json|xml|html|ya?ml|swift|java|kt|gradle|txt|strings|plist|example)$/.test(entry.name)) {
        found.push(path)
      }
    }
  }
  visit('.', false)
  for (const dir of ['.github', 'desktop', 'docs', 'mobile', 'scripts', 'server', 'src', 'subsystems']) visit(dir, true)
  return found
}

// ── .env.example ────────────────────────────────────────────────────────────

test('.env.example gives every budgetFromEnv variable the default the code uses, in milliseconds', () => {
  const example = read('.env.example')
  const budgets: Array<{ name: string; file: string; ms: number }> = []
  for (const file of tsFiles('server')) {
    if (file === 'server/run_with_deadline.ts') continue
    const source = read(file)
    for (const call of source.matchAll(/budgetFromEnv\(\s*'([A-Z][A-Z0-9_]*)'\s*,\s*([A-Za-z0-9_*+\-/ ()]+?)\s*\)/g)) {
      const [, name, fallback] = call
      const constant = /^[A-Z][A-Z0-9_]*$/.test(fallback) ? source.match(new RegExp(`const ${fallback}\\s*=\\s*([^\\n]+)`))?.[1] : fallback
      assert.ok(constant, `${file}: the default ${fallback} of ${name} is not a constant in that file`)
      budgets.push({ name, file, ms: evaluate(constant) })
    }
  }
  const names = new Set(budgets.map((budget) => budget.name))
  for (const name of ['WORLD_JOB_DEADLINE_MS', 'BRUSH_TIMEOUT_MS', 'LINGBOT_MAP_TIMEOUT_MS', 'FDANYONE_REQUEST_TIMEOUT_MS']) {
    assert.ok(names.has(name), `${name} is no longer read through budgetFromEnv, or the scan missed it`)
  }
  for (const { name, file, ms } of budgets) {
    assert.equal(exampleValue(example, name), String(ms), `.env.example must show #${name}=${ms} (${file})`)
  }
})

test('.env.example documents the LingBot-Map frame cap, with the default the code uses', () => {
  const source = read('server/lingbot-map/lingbot_map.ts')
  const fallback = source.match(/Deno\.env\.get\('LINGBOT_MAP_MAX_FRAMES'\)\s*\?\?\s*'(\d+)'/)?.[1]
  assert.ok(fallback, 'the LINGBOT_MAP_MAX_FRAMES read moved: update this test')
  assert.equal(exampleValue(read('.env.example'), 'LINGBOT_MAP_MAX_FRAMES'), fallback)
})

test('.env.example lists every torch device the workers accept, for both device variables', () => {
  const lines = read('.env.example').split('\n')
  for (const name of ['LINGBOT_MAP_DEVICE', 'PANOPTIC_DEVICE']) {
    const at = lines.findIndex((line) => line.startsWith(`#${name}=`))
    assert.ok(at > 0, `${name} is not in .env.example`)
    let start = at
    while (start > 0 && lines[start - 1].startsWith('#')) start--
    const comment = lines.slice(start, at).join('\n')
    for (const device of COMPUTE_DEVICES) {
      assert.match(comment, new RegExp(`\\b${device}\\b`), `the comment above ${name} must list "${device}"`)
    }
  }
})

test('.env.example, the README and the desktop README say that localhost needs ALLOW_DEV_ORIGINS', () => {
  const server = { prefix: 'https://box.example.ts.net', tailnetOrigin: 'https://box.example.ts.net', publicOrigin: null }
  const quickStart = read('README.md').split('## Quick setup')[1]?.split('\n---')[0] ?? ''
  const tauri = JSON.parse(read('desktop/src-tauri/tauri.conf.json'))
  const devWindow = new URL(tauri.build.devUrl).origin
  for (const [what, origin, text] of [
    ['the README quick start opens https://localhost:5173', 'https://localhost:5173', quickStart],
    [`the desktop dev window (${devWindow})`, devWindow, read('desktop/README.md')],
  ] as const) {
    assert.equal(isAllowedOrigin(origin, { ...server, devOrigins: false }), false, `${what} is refused by default`)
    assert.equal(isAllowedOrigin(origin, { ...server, devOrigins: true }), true, `${what} is admitted with the flag`)
    assert.match(text, /ALLOW_DEV_ORIGINS=1/, `${what}: the doc that sends a developer there must say the server needs ALLOW_DEV_ORIGINS=1`)
  }
  assert.match(read('.env.example'), /^#ALLOW_DEV_ORIGINS=1$/m)
})

// ── What Vite does with a .env file ─────────────────────────────────────────

/** The names the repo's vite.config.ts reads, from process.env alone. */
const CONFIG_READS = ['TAILSCALE_HOSTNAME', 'VITE_HOSTNAME', 'VITE_PORT', 'API_TARGET'] as const

/**
 * Runs a real `vite build` on a scratch project whose .env holds a VITE_ name, a plain name and the four
 * names vite.config.ts reads. Reports what the scratch config saw in process.env while it was evaluated, and
 * the bundle that came out. The project is outside the repo, so none of the repo's own config is read, and the
 * names are taken out of the environment the build inherits, so the caller's shell cannot answer for the file.
 */
function probeViteDotEnv(): { seen: Record<string, string>; bundle: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vite-dotenv-probe-'))
  try {
    const names: string[] = ['VITE_ZZ_PROBE', 'ZZ_PLAIN', ...CONFIG_READS]
    writeFileSync(join(dir, '.env'), names.map((name) => `${name}=from-dotenv`).join('\n') + '\n')
    writeFileSync(join(dir, 'main.js'), [
      "console.log('PROBE_VITE_NAME=' + import.meta.env.VITE_ZZ_PROBE)",
      "console.log('PROBE_PLAIN_NAME=' + import.meta.env.ZZ_PLAIN)",
    ].join('\n') + '\n')
    writeFileSync(join(dir, 'vite.config.mjs'), [
      'const seen = {}',
      `for (const name of ${JSON.stringify(names)}) seen[name] = process.env[name]`,
      "console.log('CONFIG_SEES ' + JSON.stringify(seen))",
      "export default { logLevel: 'warn', build: { outDir: 'out', minify: false, lib: { entry: 'main.js', formats: ['es'], fileName: 'probe' } } }",
    ].join('\n') + '\n')
    const env = { ...process.env }
    for (const name of Object.keys(env)) if (names.includes(name) || name === 'NODE_ENV') delete env[name]
    const run = spawnSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 })
    assert.equal(run.status, 0, `the scratch vite build failed:\n${run.stdout}\n${run.stderr}`)
    const seen = JSON.parse(run.stdout.match(/^CONFIG_SEES (.*)$/m)?.[1] ?? 'null') as Record<string, string> | null
    assert.ok(seen, `the scratch config printed nothing:\n${run.stdout}`)
    return { seen, bundle: readFileSync(join(dir, 'out', 'probe.mjs'), 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('Vite keeps a .env file out of process.env and hands its VITE_ names to the browser, as .env.example and architecture.md say', () => {
  const { seen, bundle } = probeViteDotEnv()
  assert.deepEqual(seen, {}, 'while a config is evaluated, no name from a .env file is in process.env, the VITE_ ones included')
  assert.match(bundle, /PROBE_VITE_NAME=from-dotenv/, 'a VITE_ name in a .env file reaches the bundle')
  assert.match(bundle, /PROBE_PLAIN_NAME=undefined/, 'a name without the VITE_ prefix does not')

  // So a .env file cannot set what vite.config.ts takes from process.env, and can set what the browser code reads.
  const config = read('vite.config.ts')
  for (const name of CONFIG_READS) assert.match(config, new RegExp(`process\\.env\\.${name}\\b`), `vite.config.ts no longer reads ${name} from process.env: update the docs and this test`)
  assert.doesNotMatch(config, /loadEnv/, 'vite.config.ts now calls loadEnv, so a .env file can reach it: the docs say it cannot')
  assert.match(read('src/rtc/feature.ts'), /import\.meta\.env\??\.VITE_ENABLE_WEBRTC_LIVE/)
  assert.match(read('src/viewer/viewer.ts'), /import\.meta\.env\??\.VITE_ENABLE_PLACE_COMPOSER/)

  const passages = {
    'the .env.example header': read('.env.example').split('\n\n')[0],
    'the architecture.md environment section': read('docs/architecture.md').match(/### Deployment Configuration & Environment Variables\n([\s\S]*?)Values below come from/)?.[1] ?? '',
  }
  for (const [where, text] of Object.entries(passages)) {
    assert.ok(text.length > 0, `${where} is missing`)
    assert.match(text, /--env-file/, `${where} must say which commands pass --env-file to the Deno server`)
    assert.match(text, /process\.env/, `${where} must say a .env file does not reach process.env`)
    assert.match(text, /import\.meta\.env/, `${where} must say the VITE_ names in a .env file reach the browser as import.meta.env`)
    for (const name of CONFIG_READS) assert.ok(text.includes(name), `${where} must name ${name}, which vite.config.ts cannot get from a .env file`)
    assert.doesNotMatch(text, /Vite, the systemd units and the Docker image do not/, `${where} says Vite reads no .env file; it reads the VITE_ names in one`)
  }
})

test('the Deno server gets --env-file from the npm and deno tasks, not from the systemd unit or the Docker image, as .env.example and architecture.md say', () => {
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
  const tasks = JSON.parse(read('deno.json')).tasks as Record<string, string>
  for (const [what, command] of [['npm run server', scripts.server], ['deno task dev', tasks.dev], ['deno task start', tasks.start]] as const) {
    assert.match(command, /--env-file/, `${what} no longer passes --env-file: the docs say it does`)
  }
  assert.match(scripts.start, /npm run server/, 'npm start no longer runs npm run server: the docs say it reads a .env file')
  assert.doesNotMatch(read('deploy/systemd/cscan-server.service'), /--env-file/, 'the systemd unit passes --env-file now: the docs say it does not')
  assert.doesNotMatch(read('Dockerfile'), /--env-file/, 'the Docker image passes --env-file now: the docs say it does not')
})

// ── docs/architecture.md ────────────────────────────────────────────────────

test('architecture.md names every native shell origin the server admits, in both CORS passages', () => {
  const architecture = read('docs/architecture.md')
  const passages = {
    'the CORS paragraph under the route table': architecture.match(/^CORS: [^\n]+/m)?.[0] ?? '',
    'the "CORS matching" section': architecture.match(/### CORS matching\n([\s\S]*?)\n###/)?.[1] ?? '',
  }
  const origins = [NATIVE_SHELL_ORIGIN, ANDROID_SHELL_ORIGIN, ...DESKTOP_SHELL_ORIGINS]
  assert.equal(origins.length, 5, 'server/origin.ts admits five shell origins')
  for (const [where, text] of Object.entries(passages)) {
    assert.ok(text.length > 0, `${where} is missing`)
    for (const origin of origins) assert.ok(text.includes(origin), `${where} must name ${origin}`)
  }
})

// ── NOTICE.md and THIRD_PARTY.md ────────────────────────────────────────────

/**
 * The sentence Google's user privacy requirements page gives an app that uses ARCore, for its main menu or
 * notice screen (https://developers.google.com/ar/develop/privacy-requirements, "last updated 2024-10-31 UTC"
 * when it was read). The page says "Google", not "Google LLC", and links "Google Play Services for AR" to its
 * Play listing and "Google Privacy Policy" to https://policies.google.com/privacy. It offers the sentence as one
 * way to meet a duty to disclose the use prominently in the app, so this repo says that, not that a string is
 * required. Change a word only after reading the page again: no test here can fetch it.
 */
const GOOGLE_ARCORE_SENTENCE = 'This application runs on Google Play Services for AR (ARCore), which is provided by Google and governed by the Google Privacy Policy.'

/** Markdown or source text with its links dropped to their text, string joins removed and every run of space made one, so a wrapped sentence can be searched for. */
const flattened = (text: string) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/['"`]\s*\+\s*['"`]/g, '').replace(/\s+/g, ' ')

test("the Android app carries ARCore, so NOTICE.md and THIRD_PARTY.md name it with its terms and Google's wording of the disclosure", () => {
  assert.match(read('mobile/android/app/build.gradle'), /implementation\s+"com\.google\.ar:core:/, 'the Android app no longer depends on ARCore: drop this test and the ARCore text')
  const termsUrl = 'https://developers.google.com/ar/develop/terms'
  const privacyUrl = 'https://policies.google.com/privacy'
  const notice = read('NOTICE.md')
  const thirdParty = read('THIRD_PARTY.md')
  assert.ok(notice.includes(termsUrl), 'NOTICE.md links the ARCore Additional Terms of Service')
  assert.ok(thirdParty.includes(termsUrl), 'THIRD_PARTY.md links the ARCore Additional Terms of Service')
  for (const [file, text] of [['NOTICE.md', notice], ['THIRD_PARTY.md', thirdParty]] as const) {
    assert.ok(flattened(text).includes(GOOGLE_ARCORE_SENTENCE), `${file} carries the disclosure in Google's own words`)
    assert.ok(text.includes(`(${privacyUrl})`), `${file} links "Google Privacy Policy" to ${privacyUrl}, as Google's page does`)
  }
  assert.ok(notice.includes('(https://play.google.com/store/apps/details?id=com.google.ar.core)'), 'NOTICE.md links "Google Play Services for AR" to its Play listing, as Google\'s page does')
  assert.ok(notice.includes('(https://developers.google.com/ar/develop/privacy-requirements)'), 'NOTICE.md names the page the sentence comes from')
  assert.match(flattened(notice), /prominently in the app/, 'NOTICE.md says what Google asks: to disclose the use prominently in the app')
  assert.match(flattened(notice), /one way to do that/, 'NOTICE.md gives the sentence as one way to disclose it, which is how Google\'s page words it')

  // The Additional Terms also ask the app's own terms to name ARCore and Google's Terms of Service and Privacy Policy.
  // The app has no terms of service here yet (the privacy policy is still on the shells' list of what is not done),
  // so NOTICE.md says whose that is.
  assert.ok(notice.includes('(https://policies.google.com/terms)'), 'NOTICE.md links the Google Terms of Service that the Additional Terms name')
  assert.match(flattened(notice), /terms of service of an app that uses ARCore must tell its users that the app includes ARCore functionality provided by Google/)
  assert.match(flattened(notice), /is the owner's to do/, 'NOTICE.md says who owns writing that into the app\'s own terms')
  assert.match(read('mobile/README.md').split('## Not done')[1] ?? '', /the privacy policy/, "mobile/README.md no longer lists the privacy policy as not done: NOTICE.md's sentence that the app has no terms yet needs checking")

  const exceptions = notice.indexOf('Not everything here is under a permissive licence')
  const everythingElse = notice.indexOf('Everything else', exceptions)
  const arcore = notice.indexOf('ARCore', exceptions)
  assert.ok(exceptions >= 0 && everythingElse > exceptions, 'NOTICE.md keeps its list of exceptions')
  assert.ok(arcore > exceptions && arcore < everythingElse, 'ARCore is one of the exceptions, not covered by "Everything else is permissive"')
})

test("every place that carries the ARCore disclosure carries Google's sentence, so the repo has one wording", () => {
  const lead = 'This application runs on Google Play Services for AR'
  const carriers = new Set<string>()
  for (const file of proseAndSourceFiles()) {
    const text = flattened(read(file))
    for (let at = text.indexOf(lead); at >= 0; at = text.indexOf(lead, at + 1)) {
      carriers.add(file)
      assert.equal(
        text.slice(at, at + GOOGLE_ARCORE_SENTENCE.length), GOOGLE_ARCORE_SENTENCE,
        `${file} carries an ARCore disclosure that is not the sentence on Google's page: the app, the notices file, NOTICE.md and THIRD_PARTY.md must all say the same words`,
      )
    }
  }
  assert.ok(carriers.has('NOTICE.md') && carriers.has('THIRD_PARTY.md'), `the scan found the disclosure in ${[...carriers].join(', ') || 'no file'}, not in NOTICE.md and THIRD_PARTY.md`)
})

// ── docs/testing/DEVICE_TEST_KIT.md ─────────────────────────────────────────

test('the device kit states the shell build contract: VITE_API_BASE is optional, and a saved address wins', () => {
  assert.equal(apiBaseProblem(undefined), null, 'an unset VITE_API_BASE builds')
  assert.equal(apiBaseProblem('https://box.example.ts.net:5173'), null)
  assert.notEqual(apiBaseProblem('http://box.example.ts.net'), null, 'a set one must still be an https origin')
  const kit = read('docs/testing/DEVICE_TEST_KIT.md')
  assert.match(kit, /`VITE_API_BASE` is optional/)
  assert.match(kit, /saved in the app (wins|overrides)|overrides (the build's|a build's)/i, 'the kit says an address saved in the app beats the build default')
})

test('the device kit has one Android emulator section, and no branch name', () => {
  const kit = read('docs/testing/DEVICE_TEST_KIT.md')
  assert.equal(kit.match(/^## Android emulator$/gm)?.length, 1)
  assert.equal(kit.match(/quickest way to see the Android shell run/g)?.length, 1, 'the emulator advice appears once')
  assert.equal(kit.match(/`pixel_6`/g)?.length, 1, 'the pixel_6 note appears once')
})

// ── Sentences that stopped being true ───────────────────────────────────────

const exportWorldHasARunner = /job\.type === 'export-world'\)\s*\{\s*await _runExportWorldJob/.test(read('server/main.ts'))
const envFileIsPassed = /--env-file/.test(JSON.parse(read('package.json')).scripts.server) && /--env-file/.test(read('deno.json'))
const capabilitiesIsServed = /app\.get\('\/capabilities'/.test(read('server/main.ts'))
const memoryPushHasButton = /publish: \[[^\]]*'memory-push'/.test(read('src/viewer/viewer.ts'))
/** `_xpu_result` hands back fp16_ok=False, so `use_autocast_fp16()` is false on Intel XPU. */
const xpuStaysFp32 = /fp16_ok=False/.test(read('scripts/_torch_device.py').match(/def _xpu_result\([\s\S]*?\n\n\n/)?.[0] ?? '')

/** Each claim was true of some tree and is not true of this one. `holds` says what makes it untrue here. */
const retired: Array<{ file: string; says: RegExp; holds: boolean; because: string }> = [
  { file: 'docs/testing/DEVICE_TEST_KIT.md', says: /feat\/goal-integration|this branch|Confirm before merge/, holds: true, because: 'the kit is for the one merged tree, and names no branch or merge gate' },
  { file: 'docs/testing/DEVICE_TEST_KIT.md', says: /ARKit session is not implemented|AR scanning in the shell is not available/, holds: /ARWorldTrackingConfiguration/.test(read('mobile/ios/App/App/ArSessionPlugin.swift')), because: 'the iOS plugin runs an ARKit session, and the shells run the 8th Wall path, which README.md calls untried, not unavailable' },
  { file: 'docs/testing/DEVICE_TEST_KIT.md', says: /Both shells need an `https` origin|The build refuses anything else/, holds: apiBaseProblem(undefined) === null, because: 'an unset VITE_API_BASE is a supported build (mobile/scripts/check-api-base.mjs)' },
  { file: 'docs/testing/DEVICE_TEST_KIT.md', says: /like the scan geometry it contains/, holds: true, because: 'the scan geometry sits behind the session guard once sign-in is on, and the export route does not borrow its rule from it' },
  { file: 'docs/architecture.md', says: /combined GLB \+ semantic JSON/, holds: exportWorldHasARunner, because: 'export-world writes one .world.glb with the tags in extras (server/world_export.ts), and no JSON beside it' },
  { file: 'docs/architecture.md', says: /`person-4d-reconstruct` and `memory-push` have no UI entry point/, holds: memoryPushHasButton, because: "the editor's Publish step queues memory-push (viewer.ts GUIDED_WORKFLOWS)" },
  { file: 'docs/product/UX_FLOW.md', says: /not yet a bundled download|only writes a manifest|world-export-plan|Seven of the nineteen/, holds: exportWorldHasARunner, because: 'export-world builds the Place GLB, and six job types write only plan metadata' },
  { file: 'docs/product/UX_FLOW.md', says: /`person-4d-reconstruct` and `memory-push` only via the API/, holds: memoryPushHasButton, because: "the editor's Publish step queues memory-push" },
  { file: 'docs/roadmap.md', says: /rather than a manifest\/worker-ready step/, holds: exportWorldHasARunner, because: 'export-world already builds one GLB for the Place' },
  { file: 'docs/operations/PLATFORM_SUPPORT.md', says: /Not yet wired into the product/, holds: capabilitiesIsServed, because: 'server/main.ts serves GET /capabilities' },
  { file: '.env.example', says: /\.env files are NOT\s+# loaded automatically|docs\/DEPLOY\.md/, holds: envFileIsPassed, because: '`npm run server` and the deno tasks pass --env-file, and the deploy doc is docs/operations/DEPLOY.md' },
  { file: 'docs/architecture.md', says: /`\.env`\s+is \*\*not\*\* auto-loaded/, holds: envFileIsPassed, because: '`npm run server` and the deno tasks pass --env-file' },
  { file: 'docs/pipelines/splat-train.md', says: /Nothing in `package\.json` or `deno\.json` passes/, holds: envFileIsPassed, because: '`npm run server` and the deno tasks pass --env-file' },
  { file: 'docs/pipelines/panoptic-scan.md', says: /nothing passes `--env-file`/, holds: envFileIsPassed, because: '`npm run server` and the deno tasks pass --env-file' },
  { file: 'docs/pipelines/lingbot-map.md', says: /fp16 autocast runs on `cuda` and `xpu` only/, holds: xpuStaysFp32, because: 'XPU is fp32 until fp16 is measured on Intel hardware (_torch_device.py, _xpu_result), so autocast never runs there' },
  { file: 'NOTICE.md', says: /Google requires an app\s+that uses ARCore to tell its users|provided by Google LLC/, holds: true, because: "Google's privacy-requirements page says an app must disclose the use prominently and offers its sentence as one way to do that; the sentence says \"provided by Google\", not \"Google LLC\"" },
  { file: 'THIRD_PARTY.md', says: /provided by Google LLC/, holds: true, because: "Google's privacy-requirements page words the sentence \"provided by Google\", not \"Google LLC\"" },
]

for (const { file, says, holds, because } of retired) {
  test(`${file} no longer says ${says}`, () => {
    assert.ok(holds, `the premise of this check is gone: ${because}`)
    assert.doesNotMatch(read(file), says, `${file} still says what is no longer true: ${because}`)
  })
}
