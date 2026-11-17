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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANDROID_LICENCES,
  ANDROID_LOCKFILE,
  CRATE_TEXTS_FROM,
  SUPPLIED_TEXTS,
  SUPPLIED_TEXT_SOURCES,
  TEXTS_DIR,
  androidLicenceTexts,
  bundleNotices,
  componentsWithoutText,
  licenceFiles,
  linkedCrates,
  lockedLibraries,
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

// ── The Android app's libraries, from the Gradle lockfile ──────────────────────────────────────

test("a Gradle lockfile's libraries are read for one configuration, and nothing else in it", () => {
  const text = [
    '# This is a Gradle generated file for dependency locking.',
    'androidx.core:core:1.17.0=debugRuntimeClasspath,releaseRuntimeClasspath',
    'androidx.test:runner:1.6.0=debugAndroidTestRuntimeClasspath',
    'org.apache.cordova:framework:14.0.1=releaseRuntimeClasspath',
    'empty=',
    '',
  ].join('\r\n')
  assert.deepEqual(lockedLibraries(text), [
    { group: 'androidx.core', artifact: 'core', version: '1.17.0' },
    { group: 'org.apache.cordova', artifact: 'framework', version: '14.0.1' },
  ])
  assert.deepEqual(lockedLibraries(text, 'debugAndroidTestRuntimeClasspath').map((l: { artifact: string }) => l.artifact), ['runner'])
})

test('every library the release APK holds is locked, transitive ones included, and each has a known licence', () => {
  const gradle = readFileSync(join(ROOT, 'mobile/android/app/build.gradle'), 'utf8')
  assert.match(gradle, /configurations\.matching \{ it\.name == 'releaseRuntimeClasspath' \}\.configureEach \{\s*resolutionStrategy\.activateDependencyLocking\(\)/,
    'the release build takes the locked versions, and fails when its libraries are not the locked ones')
  const libraries = lockedLibraries(readFileSync(ANDROID_LOCKFILE, 'utf8')) as Array<{ group: string; artifact: string; version: string }>
  const names = libraries.map((l) => `${l.group}:${l.artifact}`)
  // The ones the earlier list, read from the build.gradle files, left out.
  for (const name of ['org.apache.cordova:framework', 'androidx.lifecycle:lifecycle-runtime', 'androidx.savedstate:savedstate',
    'androidx.emoji2:emoji2', 'androidx.startup:startup-runtime', 'androidx.profileinstaller:profileinstaller',
    'androidx.tracing:tracing', 'org.jetbrains.kotlin:kotlin-stdlib', 'org.jetbrains.kotlinx:kotlinx-coroutines-core']) {
    assert.ok(names.includes(name), name)
  }
  const unknown = names.filter((name) => !name.endsWith('-bom') && !ANDROID_LICENCES.some((entry: { match: RegExp }) => entry.match.test(name)))
  assert.deepEqual(unknown, [], 'a library with no known licence stops the notices')
  const cordova = ANDROID_LICENCES.find((entry: { match: RegExp }) => entry.match.test('org.apache.cordova:framework')) as { notice?: string }
  assert.equal(cordova.notice, 'cordova-android-NOTICE.txt', "Cordova's NOTICE goes with it (Apache-2.0 section 4(d))")
})

/** A supplied licence text as the notices read it: line ends as LF, no blank lines at either end. */
const suppliedOnFile = (file: string) => readFileSync(join(TEXTS_DIR, file), 'utf8').replace(/\r\n/g, '\n').trim()
type AndroidLicence = { match: RegExp; licence: string; source: string; notice?: string; text?: string; disclosure?: string }
const androidLicence = (library: string) => ANDROID_LICENCES.filter((entry: AndroidLicence) => entry.match.test(library)) as AndroidLicence[]

test("ARCore is listed under Google's proprietary terms, with the disclosure Google asks for, then the terms' text, and no Apache License text", () => {
  const entries = androidLicence('com.google.ar:core')
  assert.equal(entries.length, 1, 'one entry names ARCore')
  const [arcore] = entries
  assert.equal(arcore!.licence, 'ARCore Additional Terms of Service')
  assert.equal(arcore!.source, 'https://developers.google.com/ar/develop/terms')
  const texts = androidLicenceTexts(arcore) as string[]
  assert.equal(texts.length, 2, "the disclosure and the terms' text: not the Apache License, and no NOTICE file of another project's")
  const [notice, terms] = texts
  assert.ok(notice!.includes('This application runs on Google Play Services for AR (ARCore), which is provided by Google and governed by the Google Privacy Policy.'),
    'the disclosure Google asks an app that uses ARCore to make')
  assert.ok(notice!.includes('Google Play Services for AR: https://play.google.com/store/apps/details?id=com.google.ar.core'), 'with the link to Google Play Services for AR')
  assert.ok(notice!.includes('Google Privacy Policy: https://policies.google.com/privacy'), 'and the link to the Google Privacy Policy the sentence names')
  assert.match(notice!, /licensed under the ARCore Additional Terms of Service, https:\/\/developers\.google\.com\/ar\/develop\/terms, not under the licence of this app/,
    'the terms it is under, linked, and not the app licence')
  assert.doesNotMatch(notice!, /Apache/, 'ARCore is not under the Apache License')
  assert.ok(notice!.length < 1000, 'the notice stays short: the proprietary agreement comes after it, as a text of its own')
  assert.match(notice!, /their text follows this notice/, 'and says the terms follow')
  assert.ok(terms!.startsWith('ARCore Additional Terms of Service\n'), "the text after it is the terms' own, from licence-texts/arcore-additional-terms.txt")
  assert.equal(terms, suppliedOnFile('arcore-additional-terms.txt'), 'copied as it is on file')
  assert.doesNotMatch(terms!, /Apache/, 'ARCore is not under the Apache License')
})

test('a library gets the Apache License 2.0 exactly when its entry says it is under it, and Cordova its NOTICE after that', () => {
  for (const entry of ANDROID_LICENCES as AndroidLicence[]) {
    assert.equal(entry.text === undefined, entry.licence === 'Apache-2.0', `${entry.match}: an entry under another licence carries its own text, and an Apache one does not`)
  }
  const [core, cordova] = ['androidx.core:core', 'org.apache.cordova:framework'].map((library) => androidLicenceTexts(androidLicence(library)[0]) as string[])
  assert.equal(core!.length, 1)
  assert.match(core![0]!, /^Apache License\b/)
  assert.equal(cordova!.length, 2)
  assert.deepEqual(cordova!.slice(0, 1), core, 'the same Apache text comes first')
  assert.match(cordova![1]!, /^Apache Cordova\b/, "Cordova's NOTICE, which section 4(d) asks to pass on")
})

// The notices as the Android app's build writes them: the whole generation, as scripts/native/build-web.mjs runs it, so
// it reads installed packages (the Apache License from typescript, Capacitor's runtime licences from mobile/node_modules).
// It is skipped where they are not installed.
const GENERATION_NEEDS = [
  'node_modules/typescript',
  'node_modules/onnxruntime-web',
  ...['android', 'app', 'browser', 'core'].map((name) => `mobile/node_modules/@capacitor/${name}`),
]
const notInstalled = GENERATION_NEEDS.filter((path) => !existsSync(join(ROOT, path)))

type Generated = {
  components: Array<{ group: string; name: string; version?: string; licence: string; source?: string; texts: string[] }>
  texts: Record<string, string>
}
const generate = bundleNotices as unknown as (options: { shell: 'mobile' | 'desktop'; bundledModules: string[] }) => Generated

test('the notices generated for the Android app give each library the text its entry names, ARCore its disclosure and its terms and not the Apache License', {
  skip: notInstalled.length ? `not installed: ${notInstalled.join(', ')} (run npm ci in the repo root and in mobile/)` : false,
}, () => {
  const notices = generate({ shell: 'mobile', bundledModules: [] })
  assert.deepEqual(componentsWithoutText(notices), [])
  const textsOf = (component: Generated['components'][number]) => component.texts.map((id) => notices.texts[id]!)
  const listed = (library: string) => notices.components.filter((c) => c.group === 'android' && c.name === library)
  // Each library the lockfile pins is listed once, at its locked version, with its entry's licence and the texts its entry names.
  const pins = (lockedLibraries(readFileSync(ANDROID_LOCKFILE, 'utf8')) as Array<{ group: string; artifact: string; version: string }>)
    .filter((pin) => !pin.artifact.endsWith('-bom'))
  assert.ok(pins.length > 20, 'the lockfile is read')
  for (const { group, artifact, version } of pins) {
    const library = `${group}:${artifact}`
    const [entry] = androidLicence(library)
    const found = listed(library)
    assert.equal(found.length, 1, `${library} is listed once`)
    assert.equal(found[0]!.version, version, `${library} at the version the lockfile pins`)
    assert.equal(found[0]!.licence, entry!.licence, `${library}: its entry's licence`)
    const texts = textsOf(found[0]!)
    assert.deepEqual(texts, androidLicenceTexts(entry), `${library}: the texts its entry names`)
    if (entry!.licence === 'Apache-2.0') assert.match(texts[0]!, /^Apache License\b/, `${library} is under the Apache License 2.0, and its first text is that licence`)
  }
  // ARCore carries the disclosure and then its terms' text, and not the Apache License.
  const [arcore] = listed('com.google.ar:core')
  assert.ok(arcore, 'ARCore is in the lockfile, so it is in the notices')
  const arcoreEntry = androidLicence('com.google.ar:core')[0]!
  assert.equal(textsOf(arcore).length, 2)
  assert.equal(textsOf(arcore)[0], arcoreEntry.disclosure, 'the disclosure first')
  assert.equal(textsOf(arcore)[1], suppliedOnFile(arcoreEntry.text!), "then the terms' text")
  assert.ok(textsOf(arcore).every((text) => !text.includes('Apache License')), 'ARCore is not under the Apache License')
  // As the notices file prints it: ARCore's notice, with the disclosure in it, applies to ARCore alone.
  const printed = renderNotices(notices, '0.0.0')
  assert.ok(printed.includes(`\n---- Applies to: com.google.ar:core ${arcore.version}\n\nThis application runs on Google Play Services for AR (ARCore), which is provided by Google and`),
    "the notices file prints ARCore's own notice under its name")
})

test('every supplied licence text is on file, says where it came from, and carries no e-mail address', () => {
  const files = readdirSync(TEXTS_DIR).sort()
  assert.deepEqual(files, Object.keys(SUPPLIED_TEXT_SOURCES).sort(), 'each file has its origin, and each origin its file')
  for (const used of Object.values(SUPPLIED_TEXTS as Record<string, string[]>).flat()) assert.ok(files.includes(used), used)
  for (const file of files) {
    const text = readFileSync(join(TEXTS_DIR, file), 'utf8')
    assert.ok(text.trim().length > 100, `${file} holds a licence`)
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.-]+/, `${file}: no e-mail address`)
  }
  assert.deepEqual(CRATE_TEXTS_FROM, { 'alloc-stdlib': 'alloc-no-stdlib' })
  const supplied: Record<string, string[] | undefined> = SUPPLIED_TEXTS
  for (const crate of ['webview2-com', 'webview2-com-macros', 'webview2-com-sys', 'objc2', 'block2', 'objc2-encode', 'objc2-foundation', 'dlopen2', 'dlopen2_derive']) {
    assert.ok(supplied[`rust:${crate}`], `${crate}, which ships no licence file on Windows, macOS or Linux`)
  }
  assert.ok(supplied['npm:onnxruntime-web'])
})

test('a component left without a licence text is named, so the notices are not made', () => {
  assert.deepEqual(componentsWithoutText(mergeNotices([PART_A])), [])
  assert.deepEqual(componentsWithoutText(PART_B), ['vendored Niantic Spatial XR Engine (8th Wall) 1.0.0'])
  const source = readFileSync(join(ROOT, 'scripts/native/third-party-notices.mjs'), 'utf8').replace(/\r\n/g, '\n')
  const build = source.slice(source.indexOf('export function bundleNotices'))
  assert.match(build, /const bare = componentsWithoutText\(json\)\n {2}if \(bare\.length\) \{\n {4}throw new Error/)
})
