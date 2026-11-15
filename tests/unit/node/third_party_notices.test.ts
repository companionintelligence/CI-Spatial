/**
 * The third-party notices each native bundle carries (scripts/native/third-party-notices.mjs):
 * which npm package a bundled module belongs to, which crates are linked rather than only built
 * with, and how the notices read and merge. The full generation runs in the shells' builds, where
 * node_modules, mobile/node_modules and the crate sources are all there.
 *
 * Run: npm run test:notices
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  licenceFiles,
  linkedCrates,
  mergeNotices,
  packageOfModule,
  renderNotices,
  rustTargets,
} from '../../../scripts/native/third-party-notices.mjs'
import { XR_ENGINE_NOTICE } from '../../../src/ui/legal-notices.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

test('a bundled module belongs to the package whose node_modules folder holds it', () => {
  assert.equal(packageOfModule('/repo/node_modules/three/build/three.module.js'), 'three')
  assert.equal(packageOfModule('C:\\repo\\node_modules\\@sparkjsdev\\spark\\dist\\spark.module.js'), '@sparkjsdev/spark')
  assert.equal(packageOfModule('/repo/node_modules/iwer/node_modules/gl-matrix/esm/vec3.js'), 'gl-matrix', 'the innermost package')
  assert.equal(packageOfModule('/repo/src/viewer/viewer.ts'), null, "the app's own code")
})

test('only crates reached through normal dependencies are linked into the app', () => {
  const dep = (pkg: string, kind: string | null) => ({ pkg, dep_kinds: [{ kind, target: null }] })
  const metadata = {
    resolve: {
      root: 'app',
      nodes: [
        { id: 'app', deps: [dep('tauri', null), dep('tauri-build', 'build')] },
        { id: 'tauri', deps: [dep('serde', null), dep('insta', 'dev')] },
        { id: 'tauri-build', deps: [dep('cargo_toml', null)] },
        { id: 'serde', deps: [] },
      ],
    },
    packages: ['app', 'tauri', 'tauri-build', 'cargo_toml', 'serde', 'insta'].map((id) => ({ id, name: id })),
  }
  assert.deepEqual(linkedCrates(metadata).map((pkg: { name: string }) => pkg.name).sort(), ['serde', 'tauri'])
})

test('a universal macOS build lists the crates of both Mac targets', () => {
  assert.deepEqual(rustTargets('universal-apple-darwin'), ['aarch64-apple-darwin', 'x86_64-apple-darwin'])
  assert.deepEqual(rustTargets('x86_64-unknown-linux-gnu'), ['x86_64-unknown-linux-gnu'])
})

test('licence and notice files are found whatever their case or suffix, and nothing else is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notices-'))
  try {
    for (const name of ['LICENSE-MIT', 'LICENSE-APACHE', 'license.md', 'NOTICE', 'COPYING', 'README.md', 'licenses.json.map']) {
      writeFileSync(join(dir, name), `${name}\r\ntext\r\n`)
    }
    const texts = licenceFiles(dir)
    assert.equal(texts.length, 5, "LICENSE-MIT, LICENSE-APACHE, license.md, NOTICE and COPYING")
    assert.ok(texts.every((text: string) => !text.includes('\r')), 'line endings are normalised, so identical texts dedupe')
    assert.ok(!texts.some((text: string) => text.startsWith('README')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const PART_A = {
  titles: ['Desktop app (x86_64-pc-windows-msvc)'],
  components: [
    { group: 'rust', name: 'option-ext', version: '0.2.0', licence: 'MPL-2.0', source: 'https://github.com/soc/option-ext', note: 'MPL-2.0 source: https://crates.io/crates/option-ext/0.2.0', texts: ['mpl'] },
    { group: 'npm', name: 'three', version: '0.184.0', licence: 'MIT', source: 'https://github.com/mrdoob/three.js', texts: ['mit-three'] },
  ],
  texts: { 'mpl': 'Mozilla Public License Version 2.0', 'mit-three': 'The MIT License\n\nCopyright © 2010-2026 three.js authors' },
}
const PART_B = {
  titles: ['Android app'],
  components: [
    { group: 'npm', name: 'three', version: '0.184.0', licence: 'MIT', source: 'https://github.com/mrdoob/three.js', texts: ['t1'] },
    { group: 'vendored', name: 'Niantic Spatial XR Engine (8th Wall)', version: '1.0.0', licence: 'XR Engine License Agreement', source: 'https://github.com/8thwall/engine/blob/main/LICENSE', texts: [] },
  ],
  texts: { t1: 'The MIT License\n\nCopyright © 2010-2026 three.js authors' },
}

test('notices merge across bundles: each component once, each licence text once', () => {
  const merged = mergeNotices([PART_A, PART_B])
  assert.deepEqual(merged.titles, ['Desktop app (x86_64-pc-windows-msvc)', 'Android app'])
  assert.deepEqual(merged.components.map((c: { name: string }) => c.name), ['option-ext', 'three', 'Niantic Spatial XR Engine (8th Wall)'])
  assert.equal(Object.keys(merged.texts).length, 2)
})

test('the rendered notices name the app licence, group the components, and print each text once', () => {
  const text = renderNotices(mergeNotices([PART_A, PART_B]), '0.2.0')
  assert.match(text, /^Companion Scan 0\.2\.0 - third-party notices\nFor: Desktop app \(x86_64-pc-windows-msvc\); Android app\n/)
  assert.match(text, /Required Notice: Copyright LifeScope INC, DBA Companion Intelligence \(https:\/\/ci\.computer\)/)
  const order = ['== Components no package manager lists ==', '== npm packages', '== Rust crates', '== Licence texts ==']
  const at = order.map((heading) => text.indexOf(heading))
  assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1]!)), `sections in order: ${at.join(', ')}`)
  assert.match(text, /\* option-ext 0\.2\.0: MPL-2\.0\n  https:\/\/github\.com\/soc\/option-ext\n  MPL-2\.0 source: https:\/\/crates\.io\/crates\/option-ext\/0\.2\.0/)
  assert.equal(text.split('The MIT License').length - 1, 1, 'one copy of a text shared by two bundles')
})

test("the engine notice in every Android app's notices is the one the app shows", () => {
  const source = readFileSync(join(ROOT, 'scripts/native/third-party-notices.mjs'), 'utf8')
  assert.ok(source.includes(XR_ENGINE_NOTICE.creator))
  assert.ok(source.includes(XR_ENGINE_NOTICE.copyright))
  assert.ok(source.includes(XR_ENGINE_NOTICE.licenceUrl))
})
