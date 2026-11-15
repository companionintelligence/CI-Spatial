#!/usr/bin/env node
/**
 * Third-party notices for a native app bundle, generated from the lockfiles.
 *
 *   node scripts/native/third-party-notices.mjs --shell desktop|mobile --bundle-report <json>
 *        --out <THIRD-PARTY-NOTICES.txt> [--json <notices.json>] [--targets <rust triple,...>]
 *   node scripts/native/third-party-notices.mjs --merge <a.json> <b.json>... --out <file.txt>
 *
 * scripts/native/build-web.mjs runs the first form for every shell build and puts the result in
 * the bundle (THIRD-PARTY-NOTICES.txt beside index.html), so each app carries its own notices.
 * The release workflow merges the JSON of every build into the release asset.
 *
 * What is listed, and where it comes from:
 *   - npm packages: the ones whose modules are in the web bundle (the Vite module list that
 *     build-web.mjs records), at the version and licence package-lock.json gives, with the
 *     licence files from node_modules.
 *   - Rust crates (desktop): the crates linked into the app, walked through Cargo.lock's
 *     normal dependencies with `cargo metadata --locked` for each target, with the licence
 *     files from each crate's source. MPL-2.0 crates also get where to download their source.
 *   - Android (mobile): Capacitor's Android runtime from mobile/package-lock.json, and the
 *     libraries the Gradle build declares (Gradle keeps no lockfile here).
 *   - Components no package manager knows: the vendored XR Engine (mobile), the Draco decoder,
 *     the onnxruntime-web WASM files, qrcodegen, and the WebView2 loader (Windows).
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const LICENCE_FILE = /^(licen[cs]e|copying|notice|unlicense)([._-].*)?$/i

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Licence and notice files at the top of a package or crate folder, sorted by name. */
export function licenceFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim())
}

/** The npm package a bundled module id belongs to, or null for the app's own code. */
export function packageOfModule(id) {
  const path = id.replace(/\\/g, '/')
  const at = path.lastIndexOf('/node_modules/')
  if (at < 0) return null
  const rest = path.slice(at + '/node_modules/'.length).split('/')
  if (!rest[0]) return null
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]
}

function repositoryOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const url = repo ?? pkg.homepage ?? null
  if (!url) return null
  // npm's shorthand: "user/repo" and "github:user/repo" name GitHub repositories.
  const shorthand = url.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/)
  if (shorthand) return `https://github.com/${shorthand[1]}`
  return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://')
}

/** Collects components and deduplicated licence texts. */
class Notices {
  constructor(title) {
    this.title = title
    this.components = []
    this.texts = {}
  }

  add(component, texts = []) {
    const ids = texts.map((text) => {
      const id = createHash('sha256').update(text).digest('hex').slice(0, 16)
      this.texts[id] = text
      return id
    })
    const key = `${component.group}|${component.name}|${component.version ?? ''}`
    if (this.components.some((c) => `${c.group}|${c.name}|${c.version ?? ''}` === key)) return
    this.components.push({ ...component, texts: ids })
  }

  toJSON() {
    return { titles: [this.title], components: this.components, texts: this.texts }
  }
}

/** npm packages in the web bundle, from the root lockfile. */
function addNpmPackages(notices, bundledModules) {
  const lock = readJson(join(ROOT, 'package-lock.json'))
  const names = [...new Set(bundledModules.map(packageOfModule).filter(Boolean))].sort()
  for (const name of names) {
    const entry = lock.packages[`node_modules/${name}`]
    if (!entry) throw new Error(`${name} is in the bundle but not in package-lock.json`)
    const dir = join(ROOT, 'node_modules', name)
    const pkg = existsSync(join(dir, 'package.json')) ? readJson(join(dir, 'package.json')) : {}
    const texts = licenceFiles(dir)
    notices.add({
      group: 'npm',
      name,
      version: entry.version,
      licence: entry.license ?? pkg.license ?? 'not declared',
      source: repositoryOf(pkg) ?? `https://www.npmjs.com/package/${name}/v/${entry.version}`,
      note: texts.length ? undefined : `The package ships no licence file; its package.json declares ${entry.license ?? 'no licence'}.`,
    }, texts)
  }
  return names
}

/** The Rust crates linked into the desktop app for `targets`: normal dependencies from the root, through Cargo.lock. */
export function linkedCrates(metadata) {
  const root = metadata.resolve.root
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const seen = new Set()
  const stack = [root]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((kind) => kind.kind === null)) stack.push(dep.pkg)
    }
  }
  seen.delete(root)
  return metadata.packages.filter((pkg) => seen.has(pkg.id))
}

function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  return out.match(/^host: (\S+)$/m)?.[1]
}

function addRustCrates(notices, targets) {
  const manifest = join(ROOT, 'desktop', 'src-tauri', 'Cargo.toml')
  const crates = new Map()
  for (const target of targets) {
    const metadata = JSON.parse(execFileSync('cargo', [
      'metadata', '--format-version', '1', '--locked', '--manifest-path', manifest, '--filter-platform', target,
    ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }))
    for (const pkg of linkedCrates(metadata)) crates.set(`${pkg.name}@${pkg.version}`, pkg)
  }
  const sorted = [...crates.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  const textsOf = new Map(sorted.map((pkg) => {
    const dir = dirname(pkg.manifest_path)
    const texts = licenceFiles(dir)
    if (pkg.license_file && existsSync(join(dir, pkg.license_file))) {
      const text = readFileSync(join(dir, pkg.license_file), 'utf8').replace(/\r\n/g, '\n').trim()
      if (!texts.includes(text)) texts.push(text)
    }
    return [pkg, texts]
  }))
  // MPL-2.0 and Apache-2.0 texts name no copyright holder, so a crate that ships no licence
  // file still gets the full text of its licence, taken from a crate that does ship it.
  const shared = {}
  for (const [pkg, texts] of textsOf) {
    if (pkg.license === 'MPL-2.0' && texts.length === 1) shared['MPL-2.0'] ??= texts[0]
    const apache = texts.find((text) => /^\s*Apache License\s+Version 2\.0/.test(text))
    if (apache) shared['Apache-2.0'] ??= apache
  }
  for (const [pkg, texts] of textsOf) {
    const licence = pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : 'not declared')
    const shipped = texts.length > 0
    if (!shipped) for (const id of ['MPL-2.0', 'Apache-2.0']) if (licence.includes(id) && shared[id]) texts.push(shared[id])
    const crate = `https://crates.io/crates/${pkg.name}/${pkg.version}`
    const mpl = /MPL-2\.0/.test(licence)
    notices.add({
      group: 'rust',
      name: pkg.name,
      version: pkg.version,
      licence,
      source: pkg.repository ?? crate,
      note: [
        mpl ? `MPL-2.0 source: ${crate}, download https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`
          + (pkg.repository ? `, repository ${pkg.repository}` : '') + '. The files under MPL-2.0 are unmodified.' : null,
        shipped ? null : texts.length ? 'The crate ships no licence file; the standard text of its licence is below.' : 'The crate ships no licence file.',
      ].filter(Boolean).join(' ') || undefined,
    }, texts)
  }
  return crates.size
}

/** Capacitor's Android runtime, from mobile/package-lock.json, and what the Gradle build declares. */
function addAndroid(notices) {
  const lock = readJson(join(ROOT, 'mobile', 'package-lock.json'))
  const runtime = ['@capacitor/android', '@capacitor/app', '@capacitor/browser', '@capacitor/core']
  for (const name of runtime) {
    const entry = lock.packages[`node_modules/${name}`]
    if (!entry) throw new Error(`${name} is not in mobile/package-lock.json`)
    const dir = join(ROOT, 'mobile', 'node_modules', name)
    const pkg = existsSync(join(dir, 'package.json')) ? readJson(join(dir, 'package.json')) : {}
    notices.add({
      group: 'android',
      name,
      version: entry.version,
      licence: entry.license ?? pkg.license ?? 'not declared',
      source: repositoryOf(pkg) ?? `https://www.npmjs.com/package/${name}/v/${entry.version}`,
    }, licenceFiles(dir))
  }
  // Gradle declares these in mobile/android (versions from variables.gradle) and in Capacitor's own
  // Android libraries. They are AndroidX and Google libraries, published under Apache-2.0.
  // A version is the app's own (variables.gradle), else the default the library's build.gradle sets.
  const variables = readFileSync(join(ROOT, 'mobile', 'android', 'variables.gradle'), 'utf8')
  const defaults = new Map()
  const gradleFiles = [
    join(ROOT, 'mobile', 'android', 'app', 'build.gradle'),
    join(ROOT, 'mobile', 'node_modules', '@capacitor', 'android', 'capacitor', 'build.gradle'),
    join(ROOT, 'mobile', 'node_modules', '@capacitor', 'app', 'android', 'build.gradle'),
    join(ROOT, 'mobile', 'node_modules', '@capacitor', 'browser', 'android', 'build.gradle'),
  ].filter(existsSync)
  for (const file of gradleFiles) {
    const text = readFileSync(file, 'utf8')
    for (const [, name, fallback] of text.matchAll(/(\w+)\s*=\s*project\.hasProperty\('\w+'\)\s*\?\s*rootProject\.ext\.\w+\s*:\s*'([^']+)'/g)) {
      if (!defaults.has(name)) defaults.set(name, fallback)
    }
  }
  const version = (name) => variables.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`))?.[1] ?? defaults.get(name)
  const apache = licenceFiles(join(ROOT, 'node_modules', 'typescript')).filter((text) => text.startsWith('Apache License'))
  for (const file of gradleFiles) {
    for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:implementation|api)\s*\(?\s*["']([\w.-]+):([\w.-]+):([^"']+)["']/gm)) {
      const [, group, artifact, spec] = match
      if (!/^(androidx\.|com\.google\.|org\.jetbrains\.kotlin)/.test(group)) continue
      const resolved = spec.startsWith('$') ? version(spec.slice(1)) ?? spec : spec
      notices.add({
        group: 'android',
        name: `${group}:${artifact}`,
        version: resolved,
        licence: 'Apache-2.0',
        source: group.startsWith('androidx.') ? 'https://developer.android.com/jetpack/androidx' : `https://mvnrepository.com/artifact/${group}/${artifact}`,
      }, apache)
    }
  }
}

function addVendored(notices, shell, targets) {
  if (shell === 'mobile') {
    notices.add({
      group: 'vendored',
      name: 'Niantic Spatial XR Engine (8th Wall), @8thwall/engine-binary',
      version: '1.0.0',
      licence: 'XR Engine License Agreement (proprietary, binary only)',
      source: 'https://github.com/8thwall/engine/blob/main/LICENSE',
      note: 'This product includes the XR Engine software developed by Niantic Spatial, Inc. '
        + 'Copyright © 2026 Niantic Spatial, Inc. All rights reserved. The XR Engine is licensed under the XR Engine '
        + 'License Agreement, linked above, and is provided "as is", without warranties of any kind (section 4 of the '
        + 'Agreement). Files: xr.js, xr-slam.js, xr-face.js and resources/, unmodified.',
    })
  }
  const draco = join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco')
  notices.add({
    group: 'vendored',
    name: 'Draco 3D decoder (Google), copied to draco/ from three',
    licence: 'Apache-2.0',
    source: 'https://github.com/google/draco',
    note: existsSync(join(draco, 'README.md')) ? 'The three.js copy states the Apache License 2.0 in its README.' : undefined,
  }, licenceFiles(join(ROOT, 'node_modules', 'typescript')).filter((text) => text.startsWith('Apache License')))
  notices.add({
    group: 'vendored',
    name: 'onnxruntime-web WebAssembly runtime (Microsoft), copied to ort/',
    version: readJson(join(ROOT, 'node_modules', 'onnxruntime-web', 'package.json')).version,
    licence: 'MIT',
    source: 'https://github.com/microsoft/onnxruntime',
  }, licenceFiles(join(ROOT, 'node_modules', 'onnxruntime-web')))
  const qr = readFileSync(join(ROOT, 'src', 'third-party', 'qrcodegen', 'qrcodegen.ts'), 'utf8')
  const qrHeader = qr.match(/^\/\*([\s\S]*?)\*\//)?.[1].split('\n').map((line) => line.replace(/^\s*\* ?/, '')).join('\n').trim()
  notices.add({
    group: 'vendored',
    name: 'QR Code generator library (Project Nayuki), in src/third-party/qrcodegen',
    licence: 'MIT',
    source: 'https://www.nayuki.io/page/qr-code-generator-library',
  }, qrHeader ? [qrHeader] : [])
  if (targets.some((target) => target.includes('windows'))) {
    notices.add({
      group: 'vendored',
      name: 'Microsoft Edge WebView2 loader (WebView2LoaderStatic.lib), linked through the webview2-com-sys crate',
      licence: 'WebView2 SDK licence (Microsoft)',
      source: 'https://www.nuget.org/packages/Microsoft.Web.WebView2',
      note: 'Copyright (C) Microsoft Corporation. Distributed under the licence of the Microsoft.Web.WebView2 package.',
    })
  }
}

/** Builds the notices for one bundle. */
export function bundleNotices({ shell, bundledModules, targets = [], title }) {
  const notices = new Notices(title ?? `${shell === 'desktop' ? 'Desktop app' : 'Android app'}${targets.length ? ` (${targets.join(', ')})` : ''}`)
  addVendored(notices, shell, targets)
  addNpmPackages(notices, bundledModules)
  if (shell === 'mobile') addAndroid(notices)
  if (shell === 'desktop') addRustCrates(notices, targets)
  return notices.toJSON()
}

/** Merges notices of several bundles into one. */
export function mergeNotices(parts) {
  const merged = new Notices('')
  merged.titles = []
  for (const part of parts) {
    merged.titles.push(...part.titles)
    for (const component of part.components) {
      merged.add({ ...component, texts: undefined }, component.texts.map((id) => part.texts[id]))
    }
  }
  return { titles: merged.titles, components: merged.components, texts: merged.texts }
}

const GROUPS = [
  ['vendored', 'Components no package manager lists'],
  ['npm', 'npm packages in the web bundle (from package-lock.json)'],
  ['android', 'Android runtime (from mobile/package-lock.json and the Gradle build)'],
  ['rust', 'Rust crates linked into the desktop app (from desktop/src-tauri/Cargo.lock)'],
]

/** The notices as the text file each bundle and each release carries. */
export function renderNotices(notices, version) {
  const lines = [
    `Companion Scan ${version} - third-party notices`,
    `For: ${notices.titles.join('; ')}`,
    'Generated from the lockfiles by scripts/native/third-party-notices.mjs.',
    '',
    'Companion Scan itself is licensed under the PolyForm Noncommercial License 1.0.0 (LICENSE).',
    'Required Notice: Copyright LifeScope INC, DBA Companion Intelligence (https://ci.computer)',
    '',
    'The software below is included in the app under its own licence. Each entry gives its version,',
    'its licence and where its source is; the licence texts follow at the end.',
  ]
  for (const [group, heading] of GROUPS) {
    const components = notices.components.filter((c) => c.group === group)
    if (!components.length) continue
    lines.push('', `== ${heading} ==`, '')
    for (const c of components) {
      lines.push(`* ${c.name}${c.version ? ` ${c.version}` : ''}: ${c.licence}`)
      if (c.source) lines.push(`  ${c.source}`)
      if (c.note) lines.push(`  ${c.note}`)
    }
  }
  const users = new Map()
  for (const c of notices.components) {
    for (const id of c.texts ?? []) users.set(id, [...(users.get(id) ?? []), `${c.name}${c.version ? ` ${c.version}` : ''}`])
  }
  lines.push('', '== Licence texts ==')
  for (const [id, names] of users) {
    lines.push('', `---- Applies to: ${names.join(', ')}`, '', notices.texts[id])
  }
  return `${lines.join('\n')}\n`
}

function parseArgs(argv) {
  const args = { merge: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--merge') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.merge.push(argv[++i])
    } else if (arg.startsWith('--')) {
      args[arg.slice(2)] = argv[++i]
    }
  }
  return args
}

/** Rust target triples for a build: Tauri's own (universal means both Mac ones), or this host's. */
export function rustTargets(triple = process.env.TAURI_ENV_TARGET_TRIPLE) {
  if (triple === 'universal-apple-darwin') return ['aarch64-apple-darwin', 'x86_64-apple-darwin']
  return [triple || hostTriple()]
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2))
  const version = readJson(join(ROOT, 'desktop', 'package.json')).version
  let notices
  if (args.merge.length) {
    notices = mergeNotices(args.merge.map(readJson))
  } else {
    const report = readJson(args['bundle-report'])
    const targets = args.shell === 'desktop' ? (args.targets ? args.targets.split(',') : rustTargets()) : []
    notices = bundleNotices({ shell: args.shell, bundledModules: report.modules, targets })
  }
  if (args.json) writeFileSync(args.json, JSON.stringify(notices))
  writeFileSync(args.out, renderNotices(notices, version))
  console.log(`[notices] ${notices.components.length} components, ${Object.keys(notices.texts).length} licence texts: ${args.out}`)
}
